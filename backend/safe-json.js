'use strict';

// Small synchronous config files are read during Electron startup, so bound
// them before allocation/JSON.parse. This prevents a truncated or accidentally
// huge dotfile from blocking the main process or exhausting memory.

const fs = require('fs');

function fileTooLarge(filePath, maxBytes) {
  const err = new Error(`${filePath} exceeds ${maxBytes} bytes`);
  err.code = 'EFILETOOBIG';
  return err;
}

function readTextBoundedSync(filePath, maxBytes = 4 * 1024 * 1024) {
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size < 0 || st.size > maxBytes) throw fileTooLarge(filePath, maxBytes);
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonBoundedSync(filePath, maxBytes = 4 * 1024 * 1024) {
  const raw = readTextBoundedSync(filePath, maxBytes);
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

module.exports = { readTextBoundedSync, readJsonBoundedSync };
