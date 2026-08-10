const THANKS_TEMPLATES = [
  (name) => `Thank you so much${name ? `, ${name}` : ""}! We're delighted you enjoyed your stay and hope to welcome you back again soon. 🙏`,
  (name) => `We really appreciate you taking the time to share this${name ? `, ${name}` : ""}! It means a lot to our team. Looking forward to hosting you again. 🙏`,
];

const NEUTRAL_TEMPLATE = (name) =>
  `Thank you for your feedback${name ? `, ${name}` : ""}. We're glad you visited us and we're taking note of your comments to keep improving your experience with us. 🙏`;

const APOLOGY_TEMPLATE = (name) =>
  `Hi${name ? ` ${name}` : ""}, thank you for letting us know, and we're sorry your experience fell short of expectations. We've shared your feedback with our team so we can address it. We'd welcome the chance to make it right on a future stay — please feel free to reach out to us directly. 🙏`;

// rating: number 1-5 (0/unknown falls back to the neutral tone)
function draftReplyForRating(rating, name = "") {
  if (rating >= 4) return THANKS_TEMPLATES[Math.floor(Math.random() * THANKS_TEMPLATES.length)](name);
  if (rating === 3) return NEUTRAL_TEMPLATE(name);
  if (rating >= 1) return APOLOGY_TEMPLATE(name);
  return NEUTRAL_TEMPLATE(name);
}

function starsDisplay(rating) {
  const n = Math.max(0, Math.min(5, rating || 0));
  return "⭐".repeat(n) + "☆".repeat(5 - n);
}

module.exports = { draftReplyForRating, starsDisplay };
