import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// Resolve each declared external dependency before linking it. A whole pnpm
// node_modules junction contains relative store and workspace links that point
// at the wrong tree when copied to a scratch root, especially on Windows.
export const linkPackageDependencies = async (root, packagePath, sourcePackagePath = packagePath) => {
  const modules = path.join(root, packagePath, "node_modules");
  const original = path.join(source, sourcePackagePath, "node_modules");
  const { dependencies = {}, devDependencies = {} } = JSON.parse(
    await readFile(path.join(source, sourcePackagePath, "package.json"), "utf8"),
  );
  for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies })) {
    if (version.startsWith("workspace:")) continue;
    const destination = path.join(modules, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(await realpath(path.join(original, name)), destination, "junction");
  }
};
