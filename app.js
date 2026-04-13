const TelegramBot = require('node-telegram-bot-api');
const Stripe = require('stripe');
const express = require('express');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripePriceId = process.env.STRIPE_PRICE_ID;
const botUsername = process.env.TELEGRAM_BOT_USERNAME;
const configuredGroupId = process.env.TELEGRAM_GROUP_ID;

if (!telegramToken) {
  throw new Error('Missing environment variable: TELEGRAM_BOT_TOKEN');
}

if (!stripeSecretKey) {
  throw new Error('Missing environment variable: STRIPE_SECRET_KEY');
}

if (!stripeWebhookSecret) {
  throw new Error('Missing environment variable: STRIPE_WEBHOOK_SECRET');
}

if (!stripePriceId) {
  throw new Error('Missing environment variable: STRIPE_PRICE_ID');
}

if (!botUsername) {
  throw new Error('Missing environment variable: TELEGRAM_BOT_USERNAME');
}

const stripe = new Stripe(stripeSecretKey);
const bot = new TelegramBot(telegramToken, { polling: true });

// Suppress noisy polling errors (e.g. 409 conflict from multiple instances)
bot.on('polling_error', (error) => {
  if (
    error &&
    error.code === 'ETELEGRAM' &&
    error.response &&
    error.response.statusCode === 409
  ) {
    // Silent ignore → expected on Render during deploy overlap
    return;
  }

  // Log only real unexpected errors
  console.error('Polling error:', error);
});

const app = express();

// Use JSON parsing for every route except Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    return next();
  }

  return express.json()(req, res, next);
});

function getGroupId() {
  const groupId = Number(configuredGroupId);

  if (!groupId) {
    throw new Error('Invalid TELEGRAM_GROUP_ID');
  }

  return groupId;
}

function normalizeTelegramData({ chatId, username, firstName }) {
  return {
    telegram_chat_id: String(chatId),
    telegram_username: username || 'no_username',
    telegram_first_name: firstName || 'unknown',
  };
}

async function createStripeCheckoutLink({ chatId, username, firstName }) {
  const telegramData = normalizeTelegramData({ chatId, username, firstName });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        price: stripePriceId,
        quantity: 1,
      },
    ],
    success_url: `https://t.me/${botUsername}`,
    cancel_url: `https://t.me/${botUsername}`,
    metadata: telegramData,
    subscription_data: {
      metadata: telegramData,
    },
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }

  return session.url;
}

async function storeTelegramMetadataOnCustomer(customerId, telegramData) {
  if (!customerId) {
    throw new Error('Missing customerId');
  }

  await stripe.customers.update(customerId, {
    metadata: telegramData,
  });
}

async function getTelegramChatIdFromCustomer(customerId) {
  if (!customerId) {
    throw new Error('Missing customerId');
  }

  const customer = await stripe.customers.retrieve(customerId);

  if (!customer || customer.deleted) {
    throw new Error(`Stripe customer not found or deleted: ${customerId}`);
  }

  const metadata = customer.metadata || {};
  const chatId = Number(metadata.telegram_chat_id);

  if (!chatId) {
    throw new Error(`Missing telegram_chat_id on Stripe customer ${customerId}`);
  }

  return chatId;
}

async function findCustomerByTelegramChatId(chatId) {
  const targetChatId = String(chatId);
  let startingAfter;

  while (true) {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    const customer = page.data.find((item) => {
      return item.metadata && item.metadata.telegram_chat_id === targetChatId;
    });

    if (customer) {
      return customer;
    }

    if (!page.has_more || page.data.length === 0) {
      return null;
    }

    startingAfter = page.data[page.data.length - 1].id;
  }
}

async function hasActiveSubscription(customerId) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  return subscriptions.data.some((subscription) => {
    return ['active', 'trialing'].includes(subscription.status);
  });
}

async function sendAccessInvite(chatId) {
  const groupId = getGroupId();

  await bot.unbanChatMember(groupId, chatId, {
    only_if_banned: true,
  });

  const inviteLink = await bot.createChatInviteLink(groupId, {
    member_limit: 1,
  });

  await bot.sendMessage(
    chatId,
    `Payment confirmed ✅\n\nHere is your private group access link:\n\n${inviteLink.invite_link}`
  );
}

async function removeUserFromGroup(chatId, reasonText) {
  const groupId = getGroupId();

  await bot.banChatMember(groupId, chatId);

  await bot.sendMessage(
    chatId,
    `${reasonText}\n\nYour access to the private group has been removed.`
  );
}

async function handleCheckoutSessionCompleted(session) {
  const metadata = session.metadata || {};
  const customerId = session.customer;
  const chatId = Number(metadata.telegram_chat_id);

  if (!chatId) {
    throw new Error('Missing telegram_chat_id in checkout.session.completed');
  }

  if (!customerId) {
    throw new Error('Missing customer in checkout.session.completed');
  }

  const telegramData = normalizeTelegramData({
    chatId,
    username: metadata.telegram_username,
    firstName: metadata.telegram_first_name,
  });

  await storeTelegramMetadataOnCustomer(customerId, telegramData);

  console.log(`Initial payment confirmed for chatId=${chatId}, customer=${customerId}`);

  await sendAccessInvite(chatId);
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;

  if (!customerId) {
    throw new Error('Missing customer in invoice.payment_failed');
  }

  const chatId = await getTelegramChatIdFromCustomer(customerId);

  console.log(`Payment failed for chatId=${chatId}, customer=${customerId}`);

  await removeUserFromGroup(chatId, 'Payment failed ❌');
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  if (!customerId) {
    throw new Error('Missing customer in customer.subscription.deleted');
  }

  const chatId = await getTelegramChatIdFromCustomer(customerId);

  console.log(`Subscription canceled for chatId=${chatId}, customer=${customerId}`);

  await removeUserFromGroup(chatId, 'Subscription canceled ❌');
}

async function handleSubscribeCommand(msg) {
  try {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'no_username';
    const firstName = msg.from.first_name || 'unknown';

    const existingCustomer = await findCustomerByTelegramChatId(chatId);

    if (existingCustomer) {
      const activeSubscription = await hasActiveSubscription(existingCustomer.id);

      if (activeSubscription) {
        await bot.sendMessage(
          chatId,
          'You already have an active subscription. Here is a new private access link.'
        );

        await sendAccessInvite(chatId);
        return;
      }
    }

    const checkoutUrl = await createStripeCheckoutLink({
      chatId,
      username,
      firstName,
    });

    await bot.sendMessage(
      chatId,
      `Welcome ${firstName} 👋\n\nClick below to start your subscription and get access to the private group:\n\n${checkoutUrl}`
    );
  } catch (error) {
    console.error('Error in subscribe flow:', error);

    try {
      await bot.sendMessage(
        msg.chat.id,
        'An error occurred while creating your payment link.'
      );
    } catch (sendError) {
      console.error('Failed to send Telegram error message:', sendError);
    }
  }
}

// Support both /start and /subscribe
bot.onText(/\/start/, handleSubscribeCommand);
bot.onText(/\/subscribe/, handleSubscribeCommand);

// Keep this log block for automatic group ID detection
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || 'no title';

  if (!process.env.TELEGRAM_GROUP_ID && (chatType === 'group' || chatType === 'supergroup')) {
    console.log('==========================================');
    console.log('TELEGRAM GROUP DETECTED');
    console.log(`GROUP_TITLE=${chatTitle}`);
    console.log(`TELEGRAM_GROUP_ID=${chatId}`);
    console.log('Copy this value into your Render environment variables.');
    console.log('Then redeploy your service.');
    console.log('==========================================');
  }
});

app.get('/', (req, res) => {
  res.send('Bot + webhook are running');
});

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        stripeWebhookSecret
      );
    } catch (error) {
      console.error('Stripe webhook signature error:', error.message);
      return res.sendStatus(400);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event.data.object);
          break;

        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object);
          break;

        default:
          console.log(`Ignored Stripe event: ${event.type}`);
          break;
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Stripe webhook handler error:', error.message);
      return res.sendStatus(500);
    }
  }
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);

  try {
    await bot.setMyCommands([
      { command: 'subscribe', description: 'Start or manage your subscription' },
    ]);

    console.log('Bot commands configured successfully');
  } catch (error) {
    console.error('Failed to set bot commands:', error.message);
  }
});