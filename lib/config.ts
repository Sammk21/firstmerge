// App-level config. Swap these for your own handles, or set them via env.

export const config = {
  // Your Buy Me a Coffee username -> https://buymeacoffee.com/<username>
  // Override with env NEXT_PUBLIC_BMC_USERNAME without touching code.
  buyMeACoffeeUser: process.env.NEXT_PUBLIC_BMC_USERNAME ?? "halalsam",

  // Public GitHub repo for the "open source" links.
  repoUrl:
    process.env.NEXT_PUBLIC_REPO_URL ??
    "https://github.com/Sammk21/firstmerge.git",
};

export const bmcUrl = `https://www.buymeacoffee.com/${config.buyMeACoffeeUser}`;
