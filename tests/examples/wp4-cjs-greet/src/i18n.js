var dict = {
  en: { hello: 'Hello', bye: 'Goodbye', label: 'English' },
  es: { hello: 'Hola',  bye: 'Adios',   label: 'Spanish' },
  fr: { hello: 'Bonjour', bye: 'Au revoir', label: 'French' },
};

exports.hello = function (lang) { return (dict[lang] || dict.en).hello; };
exports.bye   = function (lang) { return (dict[lang] || dict.en).bye; };
exports.label = function (lang) { return (dict[lang] || dict.en).label; };
