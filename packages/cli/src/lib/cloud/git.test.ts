import { describe, it, expect } from "vitest";
import { parseRepoName, normalizeRemote, remotesMatch, inferProvider } from "./git.js";

describe("git remote helpers (HOR-307)", () => {
  it("parses the repo name from SSH and HTTPS remotes", () => {
    expect(parseRepoName("git@github.com:Mhmdhammoud/maison-safqa.git")).toBe("maison-safqa");
    expect(parseRepoName("https://github.com/meritt-dev/horus.git")).toBe("horus");
    expect(parseRepoName("https://gitlab.com/group/sub/app")).toBe("app");
  });

  it("normalizes equivalent remotes to the same canonical form", () => {
    const ssh = "git@github.com:Mhmdhammoud/maison-safqa.git";
    const https = "https://github.com/Mhmdhammoud/maison-safqa";
    expect(normalizeRemote(ssh)).toBe("github.com/mhmdhammoud/maison-safqa");
    expect(normalizeRemote(https)).toBe(normalizeRemote(ssh));
  });

  it("matches the SSH and HTTPS forms of the same repo", () => {
    expect(
      remotesMatch(
        "git@github.com:Mhmdhammoud/maison-safqa.git",
        "https://github.com/Mhmdhammoud/maison-safqa",
      ),
    ).toBe(true);
    expect(
      remotesMatch(
        "git@github.com:org/repo-a.git",
        "git@github.com:org/repo-b.git",
      ),
    ).toBe(false);
  });

  it("infers the provider from the remote host", () => {
    expect(inferProvider("git@github.com:org/repo.git")).toBe("github");
    expect(inferProvider("https://gitlab.com/org/repo")).toBe("gitlab");
    expect(inferProvider("git@bitbucket.org:org/repo.git")).toBe("other");
  });
});
