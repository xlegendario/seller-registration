// index.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import Airtable from 'airtable';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_SELLERS_TABLE = 'Sellers Database',
  MAKE_PDF_WEBHOOK_URL,
  TNC_URL = 'https://bit.ly/kickzcaviar-terms', // set your real T&C URL
  PORT = 10000,
  REGISTRATION_GUILD_ID, // optional: limit auto-DM to this guild only

  // NEW: optional envs for the DM helper
  ORDER_FORM_URL = 'https://airtable.com/appHoMBqKDPnVfWJY/pagBT948BlVapOzc5/form', // e.g. https://your-order-processing-form-url
  DISCORD_INVITE_URL = 'https://discord.gg/aE4j7T8a', // e.g. https://discord.gg/yourinvite
} = process.env;

/* ---------------- EXPRESS (Render healthcheck) ---------------- */

const app = express();
app.use(morgan('tiny'));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Seller registration bot is live 🎉');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

/* -------- NEW: HTTP endpoint to DM existing sellers from Make ------- */
// POST /notify-existing-seller
// Body: { discordId: string, sellerId: string, orderId?: string, email?: string }
app.post('/notify-existing-seller', async (req, res) => {
  const { discordId, sellerId, orderId, email } = req.body || {};

  if (!discordId || !sellerId) {
    return res.status(400).json({
      success: false,
      error: 'discordId and sellerId are required in the request body.',
    });
  }

  try {
    const user = await client.users.fetch(discordId);

    const orderLine = orderId
      ? `\nThis message is about order **${orderId}**.`
      : '';

    const emailLine = email
      ? `\nThis seller profile is registered on: \`${email}\`.`
      : '';

    const orderFormLine = ORDER_FORM_URL
      ? `\n1️⃣ Using the **Order Processing form**: ${ORDER_FORM_URL}\n   – You only fill in order details + your Seller ID.`
      : `\n1️⃣ Using the **Order Processing form** (ask staff for the link)\n   – You only fill in order details + your Seller ID.`;

    const inviteLine = DISCORD_INVITE_URL
      ? `\n2️⃣ Making your deals directly inside the **Kickz Caviar server**:\n   ${DISCORD_INVITE_URL}`
      : `\n2️⃣ Making your deals directly inside the **Kickz Caviar server** (if you’re not in yet, ask us for the invite link).`;

    const message = [
      `Hey ${user.username}!`,
      '',
      'We noticed you just filled in the full **Sales Agreement** form, but you already have an active Seller Profile with **Payout by Kickz Caviar**.',
      '',
      `Your **Seller ID** is: \`${sellerId}\`.`,
      emailLine,
      orderLine,
      '',
      'Next time, you can save a lot of time by:',
      orderFormLine,
      inviteLine,
      '',
      'If you think this is a mistake or something doesn’t look right, just reply here or contact support.',
      '',
      'Thanks for selling with us 🙌',
    ].join('\n');

    const dm = await user.createDM();
    await dm.send(message);

    return res.json({ success: true });
  } catch (err) {
    console.error('Error sending existing-seller DM:', err);
    return res.status(500).json({
      success: false,
      error:
        'Failed to send DM. The user may have DMs disabled or the bot has no access.',
    });
  }
});

/* ---------------- Airtable setup ---------------- */

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing Airtable env vars.');
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const sellersTable = base(AIRTABLE_SELLERS_TABLE);

/* ---------------- Discord client ---------------- */

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN missing.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed for GuildMemberAdd (auto-DM)
  ],
  partials: [Partials.Channel],
});

/* ---------------- In-memory caches ---------------- */

// userId -> { name: 'Netherlands' }
const userCountrySelection = new Map();

// userId -> { countryName, fullName, companyName, vatId, email }
const pendingSellerContact = new Map();

/* ---------------- Country dropdown options ---------------- */

const countryOptions = [
  'Austria',
  'Belgium',
  'Bulgaria',
  'Croatia',
  'Cyprus',
  'Czech Republic',
  'Denmark',
  'Finland',
  'France',
  'Germany',
  'Greece',
  'Hungary',
  'Italy',
  'Latvia',
  'Luxembourg',
  'Netherlands',
  'Poland',
  'Portugal',
  'Romania',
  'Slovakia',
  'Slovenia',
  'Spain',
  'Sweden',
  'Norway',
  'Switzerland',
];

/* ---------------- Helper: formula escaping ---------------- */

const escapeForFormula = (str) => String(str).replace(/'/g, "\\'");

/* ---------------- Helper: find seller record for a user ---------------- */

async function findSellerRecordForInteraction(interaction) {
  const discordId = interaction.user.id;
  const discordTag = interaction.user.tag;
  const username = interaction.user.username;

  // 1) Try exact Discord ID match first (most reliable)
  const byId = await sellersTable
    .select({
      maxRecords: 1,
      filterByFormula: `{Discord ID} = '${escapeForFormula(discordId)}'`,
    })
    .firstPage();

  if (byId.length > 0) {
    return byId[0];
  }

  // 2) Build possible name candidates for the "Discord" text field
  const nameCandidates = new Set();

  if (username) nameCandidates.add(username);
  if (discordTag) nameCandidates.add(discordTag);

  // If this interaction happens inside a server, also use that member's nickname/display name
  if (interaction.member) {
    const nick = interaction.member.nickname;
    const displayName = interaction.member.displayName;

    if (nick) nameCandidates.add(nick);
    if (displayName && displayName !== nick) {
      nameCandidates.add(displayName);
    }
  } else if (REGISTRATION_GUILD_ID) {
    // Fallback for DM usage: try to fetch displayName from main guild
    try {
      const guild = await client.guilds.fetch(REGISTRATION_GUILD_ID);
      const member = await guild.members.fetch(discordId);
      if (member && member.displayName) {
        nameCandidates.add(member.displayName);
      }
    } catch (err) {
      // ignore if not found / no access
    }
  }

  if (nameCandidates.size === 0) {
    return null;
  }

  // Use CONTAINS/SEARCH instead of exact equality
  // This way "Legendario" will match "Legendario#4880"
  const conditions = [...nameCandidates]
    .map(
      (n) =>
        `SEARCH('${escapeForFormula(n)}', {Discord} & '') > 0`
    )
    .join(', ');

  const byName = await sellersTable
    .select({
      maxRecords: 1,
      filterByFormula: `OR(${conditions})`,
    })
    .firstPage();

  if (byName.length > 0) {
    return byName[0];
  }

  return null;
}


/* ---------------- Helper: shared buttons ---------------- */

// Only SIGN UP + Seller ID Check on main embeds (T&C appears after SIGN UP)
function buildRegistrationButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('seller_signup')
      .setLabel('SIGN UP')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('seller_id_check')
      .setLabel('Seller ID Check')
      .setStyle(ButtonStyle.Secondary),
  );
}

/* ---------------- Helper: channel embed (seller-registration channel) ---------------- */

function buildChannelRegistrationEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('🖊️ Seller Registration')
    .setDescription(
      [
        'Welcome to the **Payout by Kickz Caviar** seller onboarding.',
        '',
        'Use this when you’re ready to register as a seller:',
        '',
        '1. Click **SIGN UP**',
        '2. Review the Terms & Conditions',
        '3. Confirm your agreement and fill in your details',
        '',
        'After completing the form you’ll receive your **Seller ID**. A lot of opportunities are waiting for you on the other side. :smirk:',
        '',
        'Not sure if you already have a Seller ID, or you just forgot what it was?',
        '',
        'Please click the **Seller ID Check** button below. If your profile is linked to this Discord, it will show you your Seller ID.',
      ].join('\n'),
    )
    .setColor(0xFFD300);

  const row = buildRegistrationButtonsRow();
  return { embed, row };
}

/* ---------------- Helper: DM embed (on member join) ---------------- */

function buildDMRegistrationEmbed(member) {
  const embed = new EmbedBuilder()
    .setTitle('👋 Welcome to Payout by Kickz Caviar')
    .setDescription(
      [
        `Hey **${member.user.username}**!`,
        '',
        `We're excited to have you here!`,
        '',
        'Our server is full of potential, with a lot of daily WTB\'s. To get started right away and make your first deals, you have to register as a seller by completing a quick one-time Seller Registration.',
        '',
        '🧾 What you’ll get:',
        '',
        '- A unique **Seller ID**',
        '- Your details stored securely for payouts',
        '- Access to exclusive buying and selling opportunities within the Kickz Caviar network',
        '',
        '👉 Already sold with us before?',
        '',
        'Then you probably already have a Seller Profile. If you don’t remember your Seller ID, please click the **Seller ID Check** button below. If your profile is linked to this Discord, it will show you your Seller ID.',
        'You can also check your email, because we have also send your Seller ID there after the deal.',
        '',
        'No results?',
        '',
        "Don't worry, just follow the steps below:",
        '',
        'To start:',
        '1. Click **SIGN UP** below',
        '2. Review the Terms & Conditions',
        '3. Fill in your details in the forms that pop up',
      ].join('\n'),
    )
    .setColor(0xFFD300);

  const row = buildRegistrationButtonsRow();
  return { embed, row };
}

/* ---------------- Ready event: register slash cmd ---------------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);

  const setupCommand = {
    name: 'setup-seller-registration',
    description: 'Post the seller registration embed in this channel.',
  };

  try {
    const guilds = await c.guilds.fetch();
    for (const [, guild] of guilds) {
      const g = await guild.fetch();
      await g.commands.set([setupCommand]);
      console.log(`✅ Registered /setup-seller-registration in guild: ${g.name}`);
    }
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
});

/* ---------------- Auto-DM new members with DM-specific embed ---------------- */

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.user.bot) return;

    // Optional: only auto-DM for a specific guild
    if (REGISTRATION_GUILD_ID && member.guild.id !== REGISTRATION_GUILD_ID) return;

    const { embed, row } = buildDMRegistrationEmbed(member);

    await member.send({
      embeds: [embed],
      components: [row],
    });

    console.log(`✉️ Sent seller registration DM to ${member.user.tag}`);
  } catch (err) {
    // Commonly fails if user has DMs disabled
    console.warn(`⚠️ Could not DM new member ${member.user.tag}:`, err.message);
  }
});

/* ---------------- Interaction handling ---------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  const inGuild = !!interaction.guildId;
  const ephemeral = inGuild; // ephemeral in servers, normal messages in DM

  /* ----- Slash command: post main embed in a channel ----- */
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-seller-registration') {
      const { embed, row } = buildChannelRegistrationEmbed();

      await interaction.reply({
        embeds: [embed],
        components: [row],
      });
      return;
    }
  }

  /* ----- SIGN UP button → first check for existing seller, then T&C flow ----- */
  if (interaction.isButton() && interaction.customId === 'seller_signup') {
    try {
      const existingRecord = await findSellerRecordForInteraction(interaction);

      if (existingRecord) {
        const sellerId = existingRecord.get('Seller ID');
        const email = existingRecord.get('Email');

        await interaction.reply({
          content: [
            'ℹ️ You already have a seller profile with **Kickz Caviar**.',
            '',
            `Your **Seller ID** is: \`${sellerId}\`.`,
            email ? `\nThis profile is registered on: \`${email}\`` : '',
            '',
            'You do not need to register again. If something looks wrong, please contact support.',
          ].join(''),
          ephemeral,
        });
        return; // stop flow here
      }
    } catch (err) {
      console.error('Error checking existing seller on SIGN UP:', err);
      // If check fails, we still let them continue, worst case we catch duplicate later
    }

    const countrySelect = new StringSelectMenuBuilder()
      .setCustomId('seller_country_select')
      .setPlaceholder('Select your country')
      .addOptions(
        countryOptions.map((name) => ({
          label: name,
          value: name, // we only need the name
        })),
      );

    // T&C link ONLY appears here, after they clicked SIGN UP
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('📄 Open Terms & Conditions')
        .setStyle(ButtonStyle.Link)
        .setURL(TNC_URL),
    );

    const row2 = new ActionRowBuilder().addComponents(countrySelect);

    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('seller_agree')
        .setLabel('✅ I Agree & Continue')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('seller_cancel')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      content: [
        'Please follow these steps:',
        '1. Open and review our **Terms & Conditions** using the button below.',
        '2. Select your **country** from the dropdown.',
        '3. Click **I Agree & Continue** to start the registration form.',
      ].join('\n'),
      components: [row1, row2, row3],
      ephemeral,
    });

    return;
  }

  /* ----- Seller ID Check button ----- */
  if (interaction.isButton() && interaction.customId === 'seller_id_check') {
    try {
      const record = await findSellerRecordForInteraction(interaction);

      if (record) {
        const sellerId = record.get('Seller ID');
        const email = record.get('Email');

        await interaction.reply({
          content: [
            '✅ I found a seller profile linked to your Discord.',
            '',
            `Your **Seller ID** is: \`${sellerId}\`.`,
            email ? `\nThis profile is registered on: \`${email}\`` : '',
          ].join(''),
          ephemeral,
        });
      } else {
        await interaction.reply({
          content: [
            '❌ I could not find a seller profile linked to this Discord.',
            '',
            'If you have sold with us before via a form or external server, please check your email – your Seller ID was sent to you after your first completed deal.',
            '',
            'If you have never registered before, please click **SIGN UP** to create your seller profile.',
          ].join('\n'),
          ephemeral,
        });
      }
    } catch (err) {
      console.error('Error during Seller ID Check:', err);
      await interaction.reply({
        content:
          '⚠️ Something went wrong while checking your Seller ID. Please try again later or contact support.',
        ephemeral,
      });
    }

    return;
  }

  /* ----- Country dropdown ----- */
  if (interaction.isStringSelectMenu() && interaction.customId === 'seller_country_select') {
    const selectedName = interaction.values[0]; // e.g. "Netherlands"

    if (!countryOptions.includes(selectedName)) {
      await interaction.reply({
        content:
          '⚠️ Unknown country selection. Please start the registration again by clicking **SIGN UP**.',
        ephemeral,
      });
      return;
    }

    userCountrySelection.set(interaction.user.id, {
      name: selectedName,
    });

    await interaction.deferUpdate();
    return;
  }

  /* ----- Cancel button ----- */
  if (interaction.isButton() && interaction.customId === 'seller_cancel') {
    userCountrySelection.delete(interaction.user.id);
    pendingSellerContact.delete(interaction.user.id);

    await interaction.update({
      content: '❌ Seller registration cancelled.',
      components: [],
    });
    return;
  }

  /* ----- I Agree & Continue → Modal 1 (contact info) ----- */
  if (interaction.isButton() && interaction.customId === 'seller_agree') {
    const selection = userCountrySelection.get(interaction.user.id);
    if (!selection) {
      await interaction.reply({
        content:
          '⚠️ Please select your country from the dropdown first, or start the registration again by clicking **SIGN UP**.',
        ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('seller_contact_modal')
      .setTitle('Seller Registration – Step 1/2');

    const fullName = new TextInputBuilder()
      .setCustomId('full_name')
      .setLabel('Full Name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const companyName = new TextInputBuilder()
      .setCustomId('company_name')
      .setLabel('Company Name (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const vatId = new TextInputBuilder()
      .setCustomId('vat_id')
      .setLabel('VAT ID (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const email = new TextInputBuilder()
      .setCustomId('email')
      .setLabel('Email')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(fullName),
      new ActionRowBuilder().addComponents(companyName),
      new ActionRowBuilder().addComponents(vatId),
      new ActionRowBuilder().addComponents(email),
    );

    await interaction.showModal(modal);
    return;
  }

  /* ----- Modal 1 submit: store contact info & show continue button ----- */
  if (interaction.isModalSubmit() && interaction.customId === 'seller_contact_modal') {
    const selection = userCountrySelection.get(interaction.user.id);
    if (!selection) {
      await interaction.reply({
        content:
          '⚠️ Could not find your selected country. Please start the registration again by clicking **SIGN UP**.',
        ephemeral,
      });
      return;
    }

    const countryName = selection.name;

    const fullName = interaction.fields.getTextInputValue('full_name');
    const companyName = interaction.fields.getTextInputValue('company_name') || '';
    const vatId = interaction.fields.getTextInputValue('vat_id') || '';
    const email = interaction.fields.getTextInputValue('email');

    pendingSellerContact.set(interaction.user.id, {
      countryName,
      fullName,
      companyName,
      vatId,
      email,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('seller_address_continue')
        .setLabel('➡️ Continue to Address (Step 2/2)')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.reply({
      content: [
        '✅ Step 1/2 saved: contact info.',
        '',
        'Now click **Continue to Address (Step 2/2)** to fill in your address and payout info.',
      ].join('\n'),
      components: [row],
      ephemeral,
    });

    return;
  }

  /* ----- Continue to Address → Modal 2 ----- */
  if (interaction.isButton() && interaction.customId === 'seller_address_continue') {
    const pending = pendingSellerContact.get(interaction.user.id);
    if (!pending) {
      await interaction.reply({
        content:
          '⚠️ I could not find your contact info. Please start the registration again by clicking **SIGN UP**.',
        ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('seller_address_modal')
      .setTitle('Seller Registration – Step 2/2');

    const address = new TextInputBuilder()
      .setCustomId('address')
      .setLabel('Address')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const address2 = new TextInputBuilder()
      .setCustomId('address2')
      .setLabel('Address line 2 (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const zipcode = new TextInputBuilder()
      .setCustomId('zipcode')
      .setLabel('Zipcode')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const city = new TextInputBuilder()
      .setCustomId('city')
      .setLabel('City')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const payoutInfo = new TextInputBuilder()
      .setCustomId('payout_info')
      .setLabel('Payout Info (IBAN / PayPal, etc.)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(address),
      new ActionRowBuilder().addComponents(address2),
      new ActionRowBuilder().addComponents(zipcode),
      new ActionRowBuilder().addComponents(city),
      new ActionRowBuilder().addComponents(payoutInfo),
    );

    await interaction.showModal(modal);
    return;
  }

  /* ----- Modal 2 submit: create Airtable record + DM Seller ID ----- */
  if (interaction.isModalSubmit() && interaction.customId === 'seller_address_modal') {
    const pending = pendingSellerContact.get(interaction.user.id);
    if (!pending) {
      await interaction.reply({
        content:
          '⚠️ I could not find your contact info. Please start the registration again by clicking **SIGN UP**.',
        ephemeral,
      });
      return;
    }

    const { countryName, fullName, companyName, vatId, email } = pending;

    // clear pending data
    pendingSellerContact.delete(interaction.user.id);
    userCountrySelection.delete(interaction.user.id);

    const address = interaction.fields.getTextInputValue('address');
    const address2 = interaction.fields.getTextInputValue('address2') || '';
    const zipcode = interaction.fields.getTextInputValue('zipcode');
    const city = interaction.fields.getTextInputValue('city');
    const payoutInfo = interaction.fields.getTextInputValue('payout_info');

    const fullAddress = address2 ? `${address}, ${address2}` : address;

    const discordId = interaction.user.id;
    const discordTag = interaction.user.tag;

    try {
      // Check if seller already exists (Discord ID only – safety net)
      const existing = await sellersTable
        .select({
          maxRecords: 1,
          filterByFormula: `{Discord ID} = '${escapeForFormula(discordId)}'`,
        })
        .firstPage();

      if (existing.length > 0) {
        const record = existing[0];
        const existingSellerId = record.get('Seller ID');

        try {
          const dm = await interaction.user.createDM();
          await dm.send(
            `👋 You already have a seller profile with Kickz Caviar.\n\nYour **Seller ID** is: \`${existingSellerId}\`.`,
          );
        } catch (dmErr) {
          console.error('Error sending DM with existing Seller ID:', dmErr);
        }

        await interaction.reply({
          content: 'ℹ️ You already have a seller profile. I’ve sent your Seller ID in DM (if possible).',
          ephemeral,
        });

        return;
      }

      // Create new seller record in "Sellers Database"
      const created = await sellersTable.create({
        'Discord ID': discordId,
        'Discord': discordTag,
        'Full Name': fullName,
        'Company Name': companyName,
        'VAT ID': vatId,
        'Email': email,
        'Address': fullAddress,
        'Zipcode': zipcode,
        'City': city,
        'Country': countryName,
        'Payout Info': payoutInfo,
        'T&C Version': 'v1.0',
        'Agreement Text': 'Agreed via I Agree button',
      });

      const sellerId = created.get('Seller ID');

      // DM Seller ID
      try {
        const dm = await interaction.user.createDM();
        await dm.send(
          [
            '✅ Thanks for signing up as a seller with **Kickz Caviar**!',
            '',
            `Your **Seller ID** is: \`${sellerId}\``,
            '',
            'Please keep this ID safe – you may need it for support or verification.',
          ].join('\n'),
        );
      } catch (dmErr) {
        console.error('Error sending DM with new Seller ID:', dmErr);
      }

      // Trigger Make PDF flow, if configured
      if (MAKE_PDF_WEBHOOK_URL) {
        try {
          await fetch(MAKE_PDF_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              airtableRecordId: created.getId(),
              sellerId,
              discordId,
              discordTag,
              fullName,
              companyName,
              vatId,
              email,
              fullAddress,
              zipcode,
              city,
              countryName,
              payoutInfo,
              tcVersion: 'v1.0',
              agreedVia: 'button',
              timestamp: new Date().toISOString(),
            }),
          });
        } catch (err) {
          console.error('Error calling MAKE_PDF_WEBHOOK_URL:', err);
        }
      }

      await interaction.reply({
        content: '✅ Your seller profile has been created. I’ve sent your Seller ID in DM.',
        ephemeral,
      });
    } catch (err) {
      console.error('Error handling seller registration (Step 2):', err);
      await interaction.reply({
        content: '⚠️ Something went wrong while creating your seller profile. Please try again later.',
        ephemeral,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
