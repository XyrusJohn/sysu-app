const babel = require('@babel/core');
const code = `const x = import.meta.env.VITE_FIREBASE_API_KEY;`;
const result = babel.transformSync(code, {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
});
console.log("OUTPUT:", result.code);
