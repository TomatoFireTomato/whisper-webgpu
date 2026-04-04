import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "public", "manifest.json");

const raw = await fs.readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);

const permissions = Array.isArray(manifest.permissions)
    ? [...manifest.permissions]
    : [];

if (!permissions.includes("unlimitedStorage")) {
    permissions.push("unlimitedStorage");
}

manifest.permissions = permissions;

const extensionPublicKey = process.env.EXTENSION_PUBLIC_KEY?.trim();
if (extensionPublicKey) {
    manifest.key = extensionPublicKey.replace(/\s+/g, "");
} else {
    delete manifest.key;
}

await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
