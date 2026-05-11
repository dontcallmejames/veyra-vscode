import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPackageFiles, verifyPackageFiles, verifyRuntimeExternalDependencies } from './verify-package.mjs';

const contentTypeByExtension = new Map([
  ['json', 'application/json'],
  ['js', 'application/javascript'],
  ['map', 'application/json'],
  ['html', 'text/html'],
  ['md', 'text/markdown'],
  ['png', 'image/png'],
  ['txt', 'text/plain'],
  ['vscodeignore', 'text/plain'],
  ['vsixmanifest', 'text/xml'],
]);

export function vsixFileName(manifest) {
  return `${manifest.name}-${manifest.version}.vsix`;
}

export function vsixEntriesForPackage(fileList) {
  return fileList.map((file) => `extension/${toZipPath(file)}`);
}

export function contentTypesXml() {
  const defaults = [...contentTypeByExtension.entries()]
    .map(([extension, contentType]) =>
      `  <Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(contentType)}" />`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    defaults,
    '</Types>',
    '',
  ].join('\n');
}

export function createVsixManifest(manifest) {
  const categories = (manifest.categories ?? ['Other']).join(',');
  const galleryFlags = manifest.preview ? 'Public,Preview' : 'Public';
  const iconAsset = manifest.icon
    ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escapeXml(toZipPath(manifest.icon))}" Addressable="true" />`
    : undefined;
  const optionalAssets = [
    iconAsset,
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />',
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />',
  ].filter(Boolean);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher)}" />`,
    `    <DisplayName>${escapeXml(manifest.displayName ?? manifest.name)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(manifest.description ?? '')}</Description>`,
    `    <Categories>${escapeXml(categories)}</Categories>`,
    `    <GalleryFlags>${galleryFlags}</GalleryFlags>`,
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(manifest.engines?.vscode ?? '*')}" />`,
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    '  </Installation>',
    '  <Dependencies />',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />',
    ...optionalAssets,
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n');
}

function main() {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const packageVerification = verifyPackageFiles(allowedPackageFiles);
  if (!packageVerification.ok) {
    throw new Error('Internal package allowlist is invalid.');
  }

  const missingFiles = allowedPackageFiles.filter((file) => !existsSync(join(process.cwd(), file)));
  if (missingFiles.length > 0) {
    throw new Error(`Cannot package VSIX; missing runtime files: ${missingFiles.join(', ')}`);
  }

  const runtimeDependencies = verifyRuntimeExternalDependencies(
    readFileSync(join(process.cwd(), 'dist', 'extension.js'), 'utf8'),
    manifest.dependencies,
  );
  if (!runtimeDependencies.ok) {
    throw new Error(`Cannot package VSIX; undeclared runtime dependencies: ${runtimeDependencies.missing.join(', ')}`);
  }

  const entries = [
    {
      path: '[Content_Types].xml',
      content: Buffer.from(contentTypesXml(), 'utf8'),
    },
    {
      path: 'extension.vsixmanifest',
      content: Buffer.from(createVsixManifest(manifest), 'utf8'),
    },
  ];

  for (const fileOrDir of allowedPackageFiles) {
    const fullPath = join(process.cwd(), fileOrDir);
    if (!existsSync(fullPath)) {
      throw new Error(`Cannot package VSIX; missing runtime file/dir: ${fileOrDir}`);
    }

    if (fs.statSync(fullPath).isDirectory()) {
      for (const file of listFilesRecursively(fullPath)) {
        const relative = path.relative(process.cwd(), file);
        entries.push({
          path: `extension/${toZipPath(relative)}`,
          content: readFileSync(file),
        });
      }
    } else {
      entries.push({
        path: `extension/${toZipPath(fileOrDir)}`,
        content: readFileSync(fullPath),
      });
    }
  }

  const outputName = vsixFileName(manifest);
  writeFileSync(join(process.cwd(), outputName), createZip(entries));
  process.stdout.write(`Packaged ${outputName} with ${entries.length} entries.\n`);
}

import * as fs from 'node:fs';
import * as path from 'node:path';

function listFilesRecursively(dir) {
  const results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results.push(...listFilesRecursively(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function createZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(toZipPath(entry.path), 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content);
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localRecords.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(centralHeader, name);

    offset += localHeader.length + name.length + content.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralRecords);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, centralDirectory, endOfCentralDirectory]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function toZipPath(path) {
  return path.replace(/\\/g, '/');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) {
  main();
}
