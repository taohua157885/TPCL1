const markers = new Set(['modrinth.index.json', 'manifest.json', 'tpcl-export.json']);
export const contentDirs = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'defaultconfigs', 'tacz', 'schematics', 'scripts', 'kubejs', 'datapacks', 'saves'];

export function wrapperPrefix(entries) {
  const manifests = new Set();
  const instances = new Set();
  const mods = new Set();
  const content = new Set();
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.some(part => ['__macosx', '.git', '..'].includes(part.toLowerCase()))) continue;
    for (const [index, segment] of parts.entries()) {
      const part = segment.toLowerCase();
      const prefix = parts.slice(0, index).join('/') + (index ? '/' : '');
      if (contentDirs.includes(part)) {
        content.add(prefix);
        if (part === 'mods') mods.add(prefix);
        break;
      }
      if (part === 'versions' && parts[index + 1] && parts[index + 2]?.toLowerCase() === parts[index + 1].toLowerCase() + '.json') instances.add(prefix);
      if (index === parts.length - 1 && markers.has(part)) manifests.add(prefix);
    }
  }
  for (const candidates of [manifests, instances, mods, content]) {
    if (!candidates.size) continue;
    const roots = [...candidates].sort((a, b) => a.length - b.length);
    if (!roots.every(root => root.startsWith(roots[0]))) {
      throw new Error('压缩包包含多个独立游戏目录，请单独打包要导入的实例');
    }
    return roots[0];
  }
  throw new Error('没有找到整合包清单、版本文件或 mods 等游戏目录');
}

export function plainVersion(entries) {
  const versions = entries.filter(entry => /^versions\/([^/]+)\/\1\.json$/i.test(entry));
  if (versions.length < 2) return versions[0];
  const withMods = versions.filter(entry => {
    const prefix = entry.slice(0, entry.lastIndexOf('/') + 1).toLowerCase();
    return entries.some(name => name.toLowerCase().startsWith(prefix + 'mods/') || ['game/mods/', '.minecraft/mods/', 'minecraft/mods/'].some(dir => name.toLowerCase().startsWith(prefix + dir)));
  });
  if (withMods.length === 1) return withMods[0];
  throw new Error('包内有多个游戏版本，请单独打包要导入的实例');
}

// Return actual directory spellings. Missing ZIP directory records are common.
export function gameLayers(entries, start = '') {
  const prefixes = [start];
  for (const prefix of prefixes) {
    const children = new Set();
    for (const name of entries) {
      if (!name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) continue;
      const child = rest.slice(0, slash);
      if (['game', '.minecraft', 'minecraft'].includes(child.toLowerCase())) children.add(prefix + child + '/');
    }
    prefixes.push(...children);
  }
  return prefixes;
}

export function localModCount(entries, layers) {
  const mods = new Set();
  for (const prefix of layers) {
    for (const name of entries) {
      const member = name.toLowerCase();
      if (!member.startsWith(prefix.toLowerCase())) continue;
      const relative = member.slice(prefix.length);
      if (/^mods\/[^/]+\.jar(?:\.disabled)?$/.test(relative)) mods.add(relative);
    }
  }
  return mods.size;
}
