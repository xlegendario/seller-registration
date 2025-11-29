// index.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { sellersTable } from './airtableClient.js';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';

import { data as setupCmdData, execute as setupCmdExecute } from './commands/setupSellerRegistration.js';

const {
  DISCORD_TOKEN,
  MAKE_PDF_WEBHOOK_URL,
  PORT = 10000,
} = process.env;

/* ---------------- EXPRESS APP (for Render health) ---------------- */

const app = express();
app.use(morgan('tiny'));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Seller registration bot is live 🎉');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

/* ---------------- DISCORD CLIENT SETUP ---------------- */

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN missing in env.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);

  // OPTIONAL: Register the /setup-seller-registration command per guild
  // If you already have a deploy-commands script, use that instead.
  try {
    const commands = [setupCmdData.toJSON()];
    const guilds = await c.guilds.fetch();

    for (const [, guild] of guilds) {
      const g = await guild.fetch();
      await g.commands.set(commands);
      console.log(`✅ Registered commands in guild: ${g.name}`);
    }
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
});

/* ---------------- INTERACTIONS ---------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  // Slash command: /setup-seller-registration
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-seller-registration') {
      return setupCmdExecute(interaction);
    }
  }

  // BUTTON → open modal
  if (interaction.isButton() && interaction.customId === 'seller_signup') {
    const modal = new ModalBuilder()
      .setCustomId('seller_registration_modal')
      .setTitle('Seller Registration');

    const fullName = new TextInputBuilder()
      .setCustomId('full_name')
      .setLabel('Full legal name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const email = new TextInputBuilder()
      .setCustomId('email')
      .setLabel('Email address')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const country = new TextInputBuilder()
      .setCustomId('country')
      .setLabel('Country')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const company = new TextInputBuilder()
      .setCustomId('company')
      .setLabel('Company name (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const agreement = new TextInputBuilder()
      .setCustomId('agreement')
      .setLabel('Type "I AGREE" to accept Kickz Caviar T&C')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(fullName),
      new ActionRowBuilder().addComponents(email),
      new ActionRowBuilder().addComponents(country),
      new ActionRowBuilder().addComponents(company),
      new ActionRowBuilder().addComponents(agreement),
    );

    await interaction.showModal(modal);
    return;
  }

  // MODAL SUBMIT → check/create Airtable → DM + call Make
  if (interaction.isModalSubmit() && interaction.customId === 'seller_registration_modal') {
    const fullName = interaction.fields.getTextInputValue('full_name');
    const email = interaction.fields.getTextInputValue('email');
    const country = interaction.fields.getTextInputValue('country');
    const company = interaction.fields.getTextInputValue('company');
    const agreement = interaction.fields.getTextInputValue('agreement');

    if (agreement.trim().toUpperCase() !== 'I AGREE') {
      await interaction.reply({
        content: '❌ You must type **I AGREE** to accept the Kickz Caviar T&C.',
        ephemeral: true,
      });
      return;
    }

    const discordId = interaction.user.id;
    const discordTag = interaction.user.tag;

    try {
      // 1) Check if seller already exists by Discord ID
      const existing = await sellersTable
        .select({
          maxRecords: 1,
          filterByFormula: `{Discord ID} = '${discordId}'`,
        })
        .firstPage();

      if (existing.length > 0) {
        const record = existing[0];
        const existingSellerId = record.get('Seller ID');

        // DM existing Seller ID
        try {
          const dm = await interaction.user.createDM();
          await dm.send(
            `👋 You already have a seller profile with Kickz Caviar.\n\nYour **Seller ID** is: \`${existingSellerId}\`.`
          );
        } catch (dmErr) {
          console.error('Error sending DM with existing seller ID:', dmErr);
        }

        await interaction.reply({
          content: 'ℹ️ You already have a seller profile. I’ve sent your Seller ID in DM (if possible).',
          ephemeral: true,
        });

        return;
      }

      // 2) Create new seller record
      const created = await sellersTable.create({
        'Discord ID': discordId,
        'Discord Tag': discordTag,
        'Full Name': fullName,
        'Email': email,
        'Country': country,
        'Company Name': company || '',
        'Agreement Text': agreement,
        'T&C Version': 'v1.0',
      });

      const sellerId = created.get('Seller ID');

      // 3) DM new Seller ID
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
        console.error('Error sending DM with new seller ID:', dmErr);
      }

      // 4) Trigger Make to generate + attach PDF
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
              email,
              country,
              company,
              agreement,
              tcVersion: 'v1.0',
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
      console.error('Error handling seller registration:', err);
      await interaction.reply({
        content: '⚠️ Something went wrong while creating your seller profile. Please try again later.',
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
