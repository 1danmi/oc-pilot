#!/usr/bin/env node
// crx-signer.js — Build a CRX3 file from a signed ZIP.
//
// Usage: node crx-signer.js <key.pem> <source.zip> <output.crx>
//
// Invoked by scripts/build-crx.ps1 — not normally run standalone.
//
// Implements the CRX3 format (Chrome 73+) using only Node built-ins.
// Spec: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
//
// CRX3 on-disk layout:
//   "Cr24"          4 bytes  magic
//   3               4 bytes  version (little-endian uint32)
//   <header_size>   4 bytes  protobuf header length (LE uint32)
//   <header>        N bytes  protobuf-encoded CrxFileHeader
//   <zip>           M bytes  extension ZIP archive

'use strict';

const crypto = require('crypto');
const fs     = require('fs');

// ── Minimal protobuf encoding (wire-type 2 = length-delimited only) ──────────

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

// Encode a length-delimited protobuf field.
function pbField(fieldNum, data) {
  const tag = varint((fieldNum << 3) | 2);
  return Buffer.concat([tag, varint(data.length), Buffer.from(data)]);
}

// CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10 }
// AsymmetricKeyProof { public_key = 1, signature = 2 }
// SignedData { crx_id = 1 }

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, pemPath, zipPath, outPath] = process.argv;
if (!pemPath || !zipPath || !outPath) {
  console.error('Usage: node crx-signer.js <key.pem> <source.zip> <output.crx>');
  process.exit(1);
}

const pem    = fs.readFileSync(pemPath);
const zip    = fs.readFileSync(zipPath);

// Load key objects
const privKey = crypto.createPrivateKey(pem);
const pubKey  = crypto.createPublicKey(privKey);

// Public key in DER (SubjectPublicKeyInfo) — this is what Chrome stores
const pubDer = pubKey.export({ type: 'spki', format: 'der' });

// CRX extension ID = first 16 bytes of SHA-256 of the DER public key
const crxId = crypto.createHash('sha256').update(pubDer).digest().slice(0, 16);

// SignedData protobuf (field 1 = crx_id)
const signedHeaderData = pbField(1, crxId);

// The blob that gets signed:
//   "CRX3 SignedData\x00" | uint32LE(len(signedHeaderData)) | signedHeaderData | zip
const prefix = Buffer.from('CRX3 SignedData\x00');
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32LE(signedHeaderData.length);
const toSign = Buffer.concat([prefix, lenBuf, signedHeaderData, zip]);

// RSA PKCS#1 v1.5 + SHA-256 signature
const sig = crypto.sign('sha256', toSign, {
  key: privKey,
  padding: crypto.constants.RSA_PKCS1_PADDING,
});

// AsymmetricKeyProof { public_key=1, signature=2 }
const proof = Buffer.concat([pbField(1, pubDer), pbField(2, sig)]);

// CrxFileHeader { sha256_with_rsa=2, signed_header_data=10 }
const header = Buffer.concat([pbField(2, proof), pbField(10, signedHeaderData)]);

// Final file
const magic   = Buffer.from('Cr24');
const version = Buffer.alloc(4); version.writeUInt32LE(3);
const hdrSize = Buffer.alloc(4); hdrSize.writeUInt32LE(header.length);

fs.writeFileSync(outPath, Buffer.concat([magic, version, hdrSize, header, zip]));
console.log(`  Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
