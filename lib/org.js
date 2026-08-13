// Extrait l'organisation principale d'un ami depuis son objet Spectrum brut
// (meta.badges). Le badge d'org se reconnaît à son url, qui contient
// toujours "/orgs/" quand il y en a une (pas à son nom : une org peut
// légitimement s'appeler "REDACTED", vu en pratique sur au moins un compte —
// piège si on se fie au nom seul). Une org réglée en confidentialité privée
// sur RSI apparaît comme un badge nommé "[REDACTED]" mais SANS url "/orgs/"
// (url vide) : c'est ce cas-là, et seulement celui-là, qu'on rapporte comme
// "masquée".
function extractOrg(friend) {
  const badges = friend?.meta?.badges || [];
  const orgBadge = badges.find((b) => typeof b.url === 'string' && b.url.includes('/orgs/'));
  if (orgBadge) {
    return { name: orgBadge.name || null, url: orgBadge.url, redacted: 0 };
  }
  const hiddenBadge = badges.find((b) => b.name === '[REDACTED]');
  if (hiddenBadge) {
    return { name: null, url: null, redacted: 1 };
  }
  return { name: null, url: null, redacted: 0 };
}

module.exports = { extractOrg };
