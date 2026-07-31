// Log traduit pour les scripts CLI. La langue vient de SC_FRIENDS_LANG (posée
// par server.js à partir de la langue active de l'interface web quand il
// lance un script), avec repli sur le français en usage CLI direct.
const { t } = require('./i18n');

const LANG = process.env.SC_FRIENDS_LANG || 'fr';

function log(key, vars) {
  console.log(t(LANG, key, vars));
}
function err(key, vars) {
  console.error(t(LANG, key, vars));
}

module.exports = { log, err, lang: LANG };
