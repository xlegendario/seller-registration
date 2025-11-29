// commands/setupSellerRegistration.js
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('setup-seller-registration')
  .setDescription('Post the seller registration embed in this channel.');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🖊️ Seller Registration')
    .setDescription([
      'Welcome to the **Kickz Caviar** seller onboarding.',
      '',
      'Click **SIGN UP** below to create your seller profile and agree to the T&C.',
    ].join('\n'))
    .setColor(0x00ae86);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('seller_signup')
      .setLabel('SIGN UP')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
  });
}
