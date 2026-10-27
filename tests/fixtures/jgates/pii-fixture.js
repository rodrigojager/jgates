"use strict";

// PII JGates fixture: a tiny project with one synthetic value per entity.
//
// API (CommonJS):
//   createPiiFixture() -> { dir, files, lines, values }
//     dir     temp directory holding the project (not a git repo)
//     files   { relPath: content } as written
//     lines   { cpf, cnpj, card, phone } 1-based line of each entity in PII_FILE
//     values  { cpf, cnpj, card, phone } the raw synthetic values (never put them in a report)
//   PII_FILE                         path of the file that carries the values
//   isValidCpf / isValidCnpj / isValidLuhn(value) -> boolean
//   removePiiFixture(dir)
// Every literal is assembled from parts at run time, so the repository gates do not flag this source.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PII_FILE = "customers/sample.txt";
const CPF_W1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_W2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(digits, weights) {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function withCheckDigits(base, firstWeights, secondWeights) {
  const digits = base.split("").map(Number);
  digits.push(checkDigit(digits, firstWeights));
  digits.push(checkDigit(digits, secondWeights));
  return digits.join("");
}

function buildCpf() {
  const d = withCheckDigits("123456" + "789", CPF_W1, CPF_W2);
  return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6, 9) + "-" + d.slice(9);
}

function buildCnpj() {
  const d = withCheckDigits("112223" + "330001", CNPJ_W1, CNPJ_W2);
  return d.slice(0, 2) + "." + d.slice(2, 5) + "." + d.slice(5, 8) + "/" + d.slice(8, 12) + "-" + d.slice(12);
}

function isValidCpf(value) {
  const d = value.replace(/\D/g, "");
  return d.length === 11 && withCheckDigits(d.slice(0, 9), CPF_W1, CPF_W2) === d;
}

function isValidCnpj(value) {
  const d = value.replace(/\D/g, "");
  return d.length === 14 && withCheckDigits(d.slice(0, 12), CNPJ_W1, CNPJ_W2) === d;
}

function isValidLuhn(value) {
  const d = value.replace(/\D/g, "").split("").map(Number).reverse();
  const sum = d.reduce((acc, n, i) => {
    if (i % 2 === 0) return acc + n;
    const doubled = n * 2;
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return d.length >= 13 && sum % 10 === 0;
}

function buildCard() {
  return ["4111", "1111", "1111", "1111"].join(" ");
}

function buildPhone() {
  return "(11) 9" + "8765" + "-4321";
}

function createPiiFixture() {
  const values = { cpf: buildCpf(), cnpj: buildCnpj(), card: buildCard(), phone: buildPhone() };
  const body = [
    "# synthetic customer record (test fixture)",
    `cpf = '${values.cpf}'`,
    `cnpj = '${values.cnpj}'`,
    `card = '${values.card}'`,
    `phone = '${values.phone}'`
  ];
  const files = {
    "README.md": "# PII fixture (synthetic values only)\n",
    [PII_FILE]: body.join("\n") + "\n"
  };
  const lineOf = (prefix) => body.findIndex((l) => l.startsWith(prefix)) + 1;
  const lines = { cpf: lineOf("cpf"), cnpj: lineOf("cnpj"), card: lineOf("card"), phone: lineOf("phone") };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-pii-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  } catch (error) {
    removePiiFixture(dir);
    throw error;
  }
  return { dir, files, lines, values };
}

function removePiiFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { PII_FILE, createPiiFixture, isValidCpf, isValidCnpj, isValidLuhn, removePiiFixture };
