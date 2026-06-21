import path from "node:path";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const productName = "AccordAgents";
const assetsDir = path.resolve(__dirname, "assets");
const iconPath = path.join(assetsDir, "icon.icns");
const dmgBackgroundPath = path.join(assetsDir, "dmg-background.png");
const entitlementsPath = path.resolve(__dirname, "entitlements.mac.plist");
const entitlementsInheritPath = path.resolve(__dirname, "entitlements.mac.inherit.plist");
const appleCodesignIdentity = process.env.APPLE_CODESIGN_IDENTITY;
const appleSigningKeychain = process.env.SIGNING_KEYCHAIN || process.env.APPLE_KEYCHAIN;
const hasNotarizeCredentials = Boolean(
  process.env.APPLE_NOTARIZE_APPLE_ID &&
  process.env.APPLE_NOTARIZE_PASSWORD &&
  process.env.APPLE_TEAM_ID
);
const looseResourceSignSkipPattern = /\.(?:asar|bin|dat|icns|nib|pak)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ignoredRootDirectory(name: string): RegExp {
  return new RegExp(`^/${escapeRegExp(name)}(?:/|$)`);
}

function ignoredRootFile(name: string): RegExp {
  return new RegExp(`^/${escapeRegExp(name)}$`);
}

function shouldSkipLooseResourceSigning(filePath: string): boolean {
  return looseResourceSignSkipPattern.test(filePath);
}

const osxSignOptions = appleCodesignIdentity
  ? {
    identity: appleCodesignIdentity,
    ...(appleSigningKeychain ? { keychain: appleSigningKeychain } : {}),
    ignore: shouldSkipLooseResourceSigning,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    optionsForFile: (filePath: string) => {
      const isTopLevelAppBundle = filePath.endsWith(`${productName}.app`);
      return {
        entitlements: isTopLevelAppBundle ? entitlementsPath : entitlementsInheritPath,
        hardenedRuntime: true
      };
    }
  }
  : undefined;

const osxNotarizeOptions = hasNotarizeCredentials
  ? {
    appleId: process.env.APPLE_NOTARIZE_APPLE_ID as string,
    appleIdPassword: process.env.APPLE_NOTARIZE_PASSWORD as string,
    teamId: process.env.APPLE_TEAM_ID as string
  }
  : undefined;

const config = {
  packagerConfig: {
    name: productName,
    executableName: productName,
    appBundleId: process.env.MACOS_BUNDLE_ID || "com.juliakrivchikova.accordagents",
    asar: true,
    icon: iconPath,
    extendInfo: {
      CFBundleDisplayName: productName,
      CFBundleName: productName,
      LSMinimumSystemVersion: "13.0"
    },
    ignore: [
      ignoredRootDirectory(".claude"),
      ignoredRootDirectory(".codex"),
      ignoredRootDirectory(".github"),
      ignoredRootDirectory(".gstack"),
      ignoredRootDirectory(".history"),
      ignoredRootDirectory(".idea"),
      ignoredRootDirectory("assets"),
      ignoredRootDirectory("brand-research"),
      ignoredRootDirectory("docs"),
      ignoredRootDirectory("out"),
      ignoredRootDirectory("screenshots"),
      ignoredRootDirectory("scripts"),
      ignoredRootDirectory("signed"),
      ignoredRootDirectory("src"),
      ignoredRootFile(".env.local"),
      ignoredRootFile(".env.local.example"),
      ignoredRootFile(".gitignore"),
      ignoredRootFile("AGENTS.md"),
      ignoredRootFile("CLAUDE.md"),
      ignoredRootFile("Makefile"),
      ignoredRootFile("components.json"),
      ignoredRootFile("entitlements.mac.inherit.plist"),
      ignoredRootFile("entitlements.mac.plist"),
      ignoredRootFile("forge.config.ts"),
      ignoredRootFile("index.html"),
      ignoredRootFile("package-lock.json"),
      ignoredRootFile("tsconfig.json"),
      ignoredRootFile("tsconfig.main.json"),
      ignoredRootFile("tsconfig.renderer.json"),
      ignoredRootFile("vite.config.mts"),
      /[\\/]dist[\\/].*\.d\.ts$/,
      /[\\/]dist[\\/].*\.test\.js$/,
      /[\\/]node_modules[\\/]\.vite(?:[\\/]|$)/,
      /\.tsbuildinfo$/
    ],
    ...(osxSignOptions ? { osxSign: osxSignOptions } : {}),
    ...(osxNotarizeOptions ? { osxNotarize: osxNotarizeOptions } : {})
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({
      icon: iconPath,
      title: productName,
      background: dmgBackgroundPath,
      iconSize: 96,
      format: "ULFO",
      additionalDMGOptions: {
        "background-color": "#f4f7fa",
        window: {
          size: {
            width: 658,
            height: 498
          }
        }
      },
      contents: (options) => [
        {
          x: 182,
          y: 300,
          type: "file",
          path: options.appPath
        },
        {
          x: 476,
          y: 300,
          type: "link",
          path: "/Applications"
        }
      ]
    }, ["darwin"])
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ],
  publishers: []
};

export default config;
