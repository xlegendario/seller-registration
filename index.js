/* -------- HTTP endpoint to DM existing sellers from Make ------- */
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

    const lines = [];

    // Greeting
    lines.push(`Hey **${user.username}**!`, '');

    // Explain situation
    lines.push(
      'We noticed you just filled in the full **Sales Agreement** form, but you already have an active Seller Profile with **Payout by Kickz Caviar**.',
      ''
    );

    // Seller ID + email
    lines.push(`Your **Seller ID** is: \`${sellerId}\`.`);
    if (email) {
      lines.push(`This seller profile is registered on: \`${email}\`.`);
    }
    if (orderId) {
      lines.push(`This message is about order **${orderId}**.`);
    }
    lines.push('');

    // Main “next time” message focused on server deals
    lines.push(
      "Next time, you don't need to fill in the full form again."
    );
    lines.push('');

    if (DISCORD_INVITE_URL) {
      lines.push(
        'Join the **Payout by Kickz Caviar Server below to take benefit is **instant deals and many more sales opportunities**!',
        '',
        `👉 [Click here](${DISCORD_INVITE_URL})`
      );
    } else {
      lines.push(
        'If you want to catch more **quick deals and buying opportunities**, the best way is to make your deals directly inside the **Kickz Caviar server**.'
      );
    }

    lines.push(
      '',
      'If you think this is a mistake, something doesn’t look right or need help with something, just join the server above and contact support.',
      '',
      'Thanks for selling with us 🙌'
    );

    const message = lines.join('\n');

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
