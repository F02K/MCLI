import { fetchJson, fetchText } from './net';

export type ProviderId = 'vanilla' | 'paper' | 'fabric' | 'forge';

export interface DownloadPlan {
  provider: ProviderId;
  mcVersion: string;
  /** Build/loader identity used to detect updates (paper build, fabric loader+launcher, forge version). */
  identity: string;
  filename: string;
  url: string;
  kind: 'jar' | 'forge-installer';
  size?: number;
  sha1?: string;
  sha256?: string;
  /** Java major version the server needs, if known. */
  javaMajor?: number;
  /** Release channel such as STABLE or BETA (Paper). */
  channel?: string;
  /** Human readable description, e.g. "Paper 1.21.8 build 60". */
  display: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Minecraft versions, newest first. */
  versions(snapshots: boolean): Promise<string[]>;
  plan(mcVersion: string): Promise<DownloadPlan>;
}

export const DEFAULT_ENDPOINTS = {
  mojang: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  paper: 'https://fill.papermc.io/v3/projects/paper',
  fabric: 'https://meta.fabricmc.net/v2/versions',
  forgePromos: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeMaven: 'https://maven.minecraftforge.net/net/minecraftforge/forge',
};
export type Endpoints = typeof DEFAULT_ENDPOINTS;

const RELEASE_RE = /^\d+(\.\d+)*$/;

/** Java version required by a classic "1.x" Minecraft version (undefined for unknown schemes). */
export function javaForMc(mc: string): number | undefined {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(mc);
  if (!m) return undefined;
  const minor = Number(m[1]);
  const patch = Number(m[2] ?? 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/** Compares dotted versions numerically (newest first when used with sort). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Java version for a Minecraft version: known mapping for 1.x, Mojang's manifest for newer schemes (26.x). */
async function javaFor(ep: Endpoints, mc: string): Promise<number | undefined> {
  const known = javaForMc(mc);
  if (known !== undefined) return known;
  try {
    const m = await fetchJson<MojangManifest>(ep.mojang);
    const entry = m.versions.find((v) => v.id === mc);
    return entry ? (await fetchJson<MojangVersion>(entry.url)).javaVersion?.majorVersion : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Vanilla

interface MojangManifest {
  versions: { id: string; type: string; url: string }[];
}
interface MojangVersion {
  javaVersion?: { majorVersion: number };
  downloads?: { server?: { sha1: string; size: number; url: string } };
}

function vanilla(ep: Endpoints): Provider {
  return {
    id: 'vanilla',
    label: 'Vanilla (Mojang)',
    async versions(snapshots) {
      const m = await fetchJson<MojangManifest>(ep.mojang);
      return m.versions.filter((v) => snapshots || v.type === 'release').map((v) => v.id);
    },
    async plan(mc) {
      const m = await fetchJson<MojangManifest>(ep.mojang);
      const entry = m.versions.find((v) => v.id === mc);
      if (!entry) throw new Error(`Minecraft ${mc} does not exist`);
      const v = await fetchJson<MojangVersion>(entry.url);
      const dl = v.downloads?.server;
      if (!dl) throw new Error(`Minecraft ${mc} has no server download`);
      return {
        provider: 'vanilla',
        mcVersion: mc,
        identity: mc,
        filename: `minecraft_server.${mc}.jar`,
        url: dl.url,
        kind: 'jar',
        size: dl.size,
        sha1: dl.sha1,
        javaMajor: v.javaVersion?.majorVersion ?? javaForMc(mc),
        display: `Vanilla ${mc}`,
      };
    },
  };
}

// ---------------------------------------------------------------- Paper

interface PaperProject {
  versions: Record<string, string[]>;
}
interface PaperBuild {
  id: number;
  channel: string;
  downloads: Record<string, { name: string; url: string; size: number; checksums: { sha256: string } }>;
}

function paper(ep: Endpoints): Provider {
  return {
    id: 'paper',
    label: 'Paper',
    async versions(snapshots) {
      const p = await fetchJson<PaperProject>(ep.paper);
      return Object.values(p.versions)
        .flat()
        .filter((v) => snapshots || RELEASE_RE.test(v));
    },
    async plan(mc) {
      const builds = await fetchJson<PaperBuild[]>(`${ep.paper}/versions/${encodeURIComponent(mc)}/builds`);
      if (!builds.length) throw new Error(`Paper has no builds for ${mc}`);
      // newest build, preferring the STABLE channel
      const sorted = [...builds].sort((a, b) => b.id - a.id);
      const build = sorted.find((b) => b.channel === 'STABLE') ?? sorted[0];
      const dl = build.downloads['server:default'];
      if (!dl) throw new Error(`Paper build ${build.id} has no server download`);
      return {
        provider: 'paper',
        mcVersion: mc,
        identity: String(build.id),
        filename: dl.name,
        url: dl.url,
        kind: 'jar',
        size: dl.size,
        sha256: dl.checksums.sha256,
        javaMajor: await javaFor(ep, mc),
        channel: build.channel,
        display: `Paper ${mc} build ${build.id}${build.channel !== 'STABLE' ? ` (${build.channel})` : ''}`,
      };
    },
  };
}

// ---------------------------------------------------------------- Fabric

interface FabricGame {
  version: string;
  stable: boolean;
}
interface FabricComponent {
  version: string;
  stable: boolean;
}

function fabric(ep: Endpoints): Provider {
  return {
    id: 'fabric',
    label: 'Fabric',
    async versions(snapshots) {
      const games = await fetchJson<FabricGame[]>(`${ep.fabric}/game`);
      return games.filter((g) => snapshots || g.stable).map((g) => g.version);
    },
    async plan(mc) {
      const [loaders, installers] = await Promise.all([
        fetchJson<FabricComponent[]>(`${ep.fabric}/loader`),
        fetchJson<FabricComponent[]>(`${ep.fabric}/installer`),
      ]);
      const loader = (loaders.find((l) => l.stable) ?? loaders[0])?.version;
      const installer = (installers.find((i) => i.stable) ?? installers[0])?.version;
      if (!loader || !installer) throw new Error('Fabric meta returned no loader/installer versions');
      return {
        provider: 'fabric',
        mcVersion: mc,
        identity: `${loader}/${installer}`,
        filename: `fabric-server-mc.${mc}-loader.${loader}-launcher.${installer}.jar`,
        url: `${ep.fabric}/loader/${encodeURIComponent(mc)}/${loader}/${installer}/server/jar`,
        kind: 'jar',
        javaMajor: await javaFor(ep, mc),
        display: `Fabric ${mc} (loader ${loader})`,
      };
    },
  };
}

// ---------------------------------------------------------------- Forge

interface ForgePromos {
  promos: Record<string, string>;
}

/** Forge installers are supported from 1.12.2 on. */
const FORGE_MIN = '1.12.2';

function forge(ep: Endpoints): Provider {
  const promos = () => fetchJson<ForgePromos>(ep.forgePromos);
  return {
    id: 'forge',
    label: 'Forge',
    async versions() {
      const p = await promos();
      const set = new Set<string>();
      for (const key of Object.keys(p.promos)) {
        const mc = key.replace(/-(latest|recommended)$/, '');
        if (RELEASE_RE.test(mc) && compareVersions(mc, FORGE_MIN) <= 0) set.add(mc);
      }
      return [...set].sort(compareVersions);
    },
    async plan(mc) {
      const p = await promos();
      const fv = p.promos[`${mc}-recommended`] ?? p.promos[`${mc}-latest`];
      if (!fv) throw new Error(`Forge has no build for ${mc}`);
      const base = `${ep.forgeMaven}/${mc}-${fv}`;
      const filename = `forge-${mc}-${fv}-installer.jar`;
      const url = `${base}/${filename}`;
      let sha1: string | undefined;
      try {
        sha1 = (await fetchText(`${url}.sha1`)).trim().split(/\s+/)[0];
        if (!/^[0-9a-f]{40}$/i.test(sha1)) sha1 = undefined;
      } catch {
        // no checksum published
      }
      return {
        provider: 'forge',
        mcVersion: mc,
        identity: fv,
        filename,
        url,
        kind: 'forge-installer',
        sha1,
        javaMajor: await javaFor(ep, mc),
        display: `Forge ${mc} (${fv})`,
      };
    },
  };
}

export function createProviders(ep: Endpoints = DEFAULT_ENDPOINTS): Record<ProviderId, Provider> {
  return { vanilla: vanilla(ep), paper: paper(ep), fabric: fabric(ep), forge: forge(ep) };
}

export const PROVIDER_ORDER: ProviderId[] = ['paper', 'vanilla', 'fabric', 'forge'];
