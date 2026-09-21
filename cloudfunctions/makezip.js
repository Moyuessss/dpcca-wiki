const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SRC = process.argv[2];
const OUT = process.argv[3];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date.getDate(), m = date.getMonth() + 1, y = date.getFullYear();
  const h = date.getHours(), min = date.getMinutes(), s = date.getSeconds();
  return {
    time: (h << 11) | (min << 5) | (s >> 1),
    date: ((y - 1980) << 9) | (m << 5) | d,
  };
}

const files = fs.readdirSync(SRC).sort();
const chunks = [];
const central = [];
let offset = 0;

for (const name of files) {
  const full = path.join(SRC, name);
  const stat = fs.statSync(full);
  const content = stat.isFile() ? fs.readFileSync(full) : Buffer.alloc(0);

  const isExec = name === "scf_bootstrap";
  // Unix external attributes: 0755 for scf_bootstrap, 0644 otherwise
  const mode = isExec ? 0o100755 : 0o100644;
  const externalAttr = (mode << 16) >>> 0;
  const dos = dosDateTime(stat.mtime);

  // Use STORED (method 0) for maximal compatibility with SCF unzip
  const crc = crc32(content);
  const nameBuf = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags: 0 (no UTF-8 flag, ascii names)
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(dos.time, 10);
  local.writeUInt16LE(dos.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBuf, content);
  const localSize = 30 + nameBuf.length + content.length;

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); // signature
  cd.writeUInt16LE(0x0314, 4); // version made by: (3<<8)|20 = Unix OS, spec 2.0
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // method: stored
  cd.writeUInt16LE(dos.time, 12);
  cd.writeUInt16LE(dos.date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(content.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(externalAttr, 38); // external attrs (unix mode)
  cd.writeUInt32LE(offset, 42); // local header offset

  central.push(cd, nameBuf);
  offset += localSize;
}

const cdSize = central.reduce((s, b) => s + b.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const out = Buffer.concat([...chunks, ...central, eocd]);
fs.writeFileSync(OUT, out);
console.log("zip written:", OUT, out.length, "bytes, files:", files.join(","));
