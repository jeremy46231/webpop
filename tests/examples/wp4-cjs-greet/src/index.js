var greet = require('./greet');
var farewell = require('./farewell');
var i18n = require('./i18n');

var users = ['Alice', 'Bob', 'Carol'];
var langs = ['en', 'es', 'fr'];

users.forEach(function (user, i) {
  var lang = langs[i % langs.length];
  console.log(greet(user, lang) + ' (' + i18n.label(lang) + ')');
  console.log(farewell(user, lang));
  console.log('---');
});
