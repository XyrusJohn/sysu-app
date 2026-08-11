// Polyfill
globalThis.import = globalThis.import || { meta: { env: process.env } };

// Simulate the transformed code
const transformed = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = void 0;
const x = import.meta.env.VITE_FIREBASE_API_KEY || "default";
var _default = exports.default = x;
`;

const Module = require('module');
const m = new Module('test');
m._compile(transformed, 'test.js');
console.log("Loaded value:", m.exports.default);
