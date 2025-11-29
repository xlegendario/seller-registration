// index.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

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

import Airtable from 'airtable';

const {
  DISCORD_TOKEN,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_SELLERS_TABLE = 'Sellers',
  MAKE_PDF_WEBHOOK_URL,
  TNC_URL = 'https://kickzcaviar.nl/terms', // change to your T&C URL
  PORT = 10000,
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
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

/* ---------------- In-memory country selection cache ---------------- */
// userId -> { name: 'Netherlands', code: 'NL' }
const userCountrySelection = new Map();

/* ---------------- Helper: country options ---------------- */

const countryOptions = [
  { label: 'Netherlands', value: 'NL' },
  { label: 'Belgium', value: 'BE' },
  { label: 'Germany', value: 'DE' },
  { label: 'France', value: 'FR' },
  { label: 'Italy', value: 'IT' },
  { label: 'Spain', value: 'ES' },
  { label: 'Portugal', value: 'PT' },
  { label: 'Poland', value: 'PL' },
  { label: 'Austria', value: 'AT' },
  { label: 'Sweden', value: 'SE' },
  { label: 'Denmark', value: 'DK' },
  { label: 'United Kingdom', value: 'GB' },
  // add/remove countries as needed
];

function getCountryByCode(code) {
  return countryOptions.find((c) => c.value === code);
}

/* ---------------- Ready event: register command ---------------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);

  // Simple inline definition of the /setup-seller-registration command
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

/* ---------------- Interaction handling ---------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  /* ----- Slash command: post embed ----- */
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-seller-registration') {
      const embed = new EmbedBuilder()
        .setTitle('🖊️ Seller Registration')
        .setDescription([
          'Welcome to the **Kickz Caviar** seller onboarding.',
          '',
          'To sign up as a seller:',
          '1. Click **SIGN UP**',
          '2. Review the Terms & Conditions',
          '3. Confirm your agreement and fill in your details',
        ].join('\n'))
        .setColor(0x00ae86);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('📄 Terms & Conditions')
          .setStyle(ButtonStyle.Link)
          .setURL(TNC_URL),
        new ButtonBuilder()
          .setCustomId('seller_signup')
          .setLabel('SIGN UP')
          .setStyle(ButtonStyle.Primary),
      );

      await interaction.reply({
        embeds: [embed],
        components: [row],
      });
      return;
    }
  }

  /* ----- SIGN UP button → send ephemeral step with T&C + country + I Agree ----- */
  if (interaction.isButton() && interaction.customId === 'seller_signup') {
    const countrySelect = new StringSelectMenuBuilder()
      .setCustomId('seller_country_select')
      .setPlaceholder('Select your country')
      .addOptions(
        countryOptions.map((c) => ({
          label: c.label,
          value: c.value,
        })),
      );

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
        '1. Open and review our **Terms & Conditions**.',
        '2. Select your **country** from the dropdown.',
        '3. Click **I Agree & Continue** to start the registration form.',
      ].join('\n'),
      components: [row1, row2, row3],
      ephemeral: true,
    });

    return;
  }

  /* ----- Country select menu ----- */
  if (interaction.isStringSelectMenu() && interaction.customId === 'seller_country_select') {
    const selectedCode = interaction.values[0]; // e.g. "NL"
    const country = getCountryByCode(selectedCode);

    if (!country) {
      await interaction.reply({
        content: '⚠️ Unknown country selection. Please try again.',
        ephemeral: true,
      });
      return;
    }

    // Save selection in memory cache
    userCountrySelection.set(interaction.user.id, {
      name: country.label,
      code: country.value,
    });

    // No need to change the message; just acknowledge
    await interaction.deferUpdate();
    return;
  }

  /* ----- I Agree & Continue / Cancel buttons ----- */
  if (interaction.isButton() && interaction.customId === 'seller_agree') {
    const selection = userCountrySelection.get(interaction.user.id);
    if (!selection) {
      await interaction.reply({
        content: '⚠️ Please select your country from the dropdown first.',
        ephemeral: true,
      });
      return;
    }

    // Build modal WITHOUT country field (we already have it)
    const modal = new ModalBuilder()
      .setCustomId('seller_registration_modal')
      .setTitle('Seller Registration');

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
      new ActionRowBuilder().addComponents(fullName),
      new ActionRowBuilder().addComponents(companyName),
      new ActionRowBuilder().addComponents(vatId),
      new ActionRowBuilder().addComponents(email),
      new ActionRowBuilder().addComponents(address),
      new ActionRowBuilder().addComponents(address2),
      new ActionRowBuilder().addComponents(zipcode),
      new ActionRowBuilder().addComponents(city),
      new ActionRowBuilder().addComponents(payoutInfo),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isButton() && interaction.customId === 'seller_cancel') {
    // Clear cached country and remove components
    userCountrySelection.delete(interaction.user.id);

    await interaction.update({
      content: '❌ Seller registration cancelled.',
      components: [],
    });
    return;
  }

  /* ----- Modal submit: create Airtable seller + DM Seller ID + call Make ----- */
  if (interaction.isModalSubmit() && interaction.customId === 'seller_registration_modal') {
    const selection = userCountrySelection.get(interaction.user.id);
    if (!selection) {
      // Should not happen normally, but just in case
      await interaction.reply({
        content: '⚠️ Could not find your selected country. Please start the registration again.',
        ephemeral: true,
      });
      return;
    }

    // Remove from cache now that we're processing
    userCountrySelection.delete(interaction.user.id);

    const countryName = selection.name; // For Airtable "Country"
    const countryCode = selection.code; // If you want a "Country Code" field

    const fullName = interaction.fields.getTextInputValue('full_name');
    const companyName = interaction.fields.getTextInputValue('company_name');
    const vatId = interaction.fields.getTextInputValue('vat_id');
    const email = interaction.fields.getTextInputValue('email');
    const address = interaction.fields.getTextInputValue('address');
    const address2 = interaction.fields.getTextInputValue('address2');
    const zipcode = interaction.fields.getTextInputValue('zipcode');
    const city = interaction.fields.getTextInputValue('city');
    const payoutInfo = interaction.fields.getTextInputValue('payout_info');

    const discordId = interaction.user.id;
    const discordTag = interaction.user.tag;

    // Combine Address + Address line 2 with comma if line 2 exists
    const fullAddress = address2 && address2.trim() !== ''
      ? `${address}, ${address2}`
      : address;

    try {
      // Check if seller already exists by Discord ID
      const existing = await sellersTable
        .select({
          maxRecords: 1,
          filterByFormula: `{Discord ID} = '${discordId}'`,
        })
        .firstPage();

      if (existing.length > 0) {
        const record = existing[0];
        const existingSellerId = record.get('Seller ID');

        try {
          const dm = await interaction.user.createDM();
          await dm.send(
            `👋 You already have a seller profile with Kickz Caviar.\n\nYour **Seller ID** is: \`${existingSellerId}\`.`
          );
        } catch (dmErr) {
          console.error('Error sending DM with existing Seller ID:', dmErr);
        }

        await interaction.reply({
          content: 'ℹ️ You already have a seller profile. I’ve sent your Seller ID in DM (if possible).',
          ephemeral: true,
        });

        return;
      }

      // Create new seller record mapped exactly to your Sellers Dashboard fields
      const created = await sellersTable.create({
        'Discord ID': discordId,
        'Discord': discordTag,
        'Full Name': fullName,
        'Company Name': companyName || '',
        'VAT ID': vatId || '',
        'Email': email,
        'Address': fullAddress,
        'Zipcode': zipcode,
        'City': city,
        'Country': countryName, // you can also store countryCode in another field
        'Payout Info': payoutInfo,
        // Optional extra fields for proof of consent:
        'T&C Version': 'v1.0',
        'Agreement Text': 'Agreed via I Agree button',
      });

      const sellerId = created.get('Seller ID');

      // DM their seller ID
      try {
        const dm = await interaction.user.createDM();
        await dm.send([
          '✅ Thanks for signing up as a seller with **Kickz Caviar**!',
          '',
          `Your **Seller ID** is: \`${sellerId}\``,
          '',
          'Please keep this ID safe – you may need it for support or verification.',
        ].join('\n'));
      } catch (dmErr) {
        console.error('Error sending DM with new Seller ID:', dmErr);
      }

      // Call Make webhook to generate + attach PDF (if configured)
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
              countryCode,
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
        ephemeral: true,
      });
    } catch (err) {
      console.error('Error handling seller registration modal:', err);
      await interaction.reply({
        content: '⚠️ Something went wrong while creating your seller profile. Please try again later.',
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
