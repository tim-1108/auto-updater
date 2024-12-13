import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec, execSync } from "node:child_process";
import axios from "axios";
import type { Readable } from "node:stream";

const COMMIT_SAVE_FILE = "last_commit";
const SHA_HASH_LENGTH = 40;
async function readSavedCommitId(): Promise<string | null> {
    try {
        const file = await fs.readFile(COMMIT_SAVE_FILE);
        if (file.length !== SHA_HASH_LENGTH) return null;
        return file.toString("ascii");
    } catch {
        return null;
    }
}

const { REPO_NAME, OWNER_NAME, BRANCH_NAME, BUILD_CMD } = process.env;
if (!REPO_NAME || !OWNER_NAME || !BRANCH_NAME) throw new TypeError("Repo name, owner or branch not defined");
if (!BUILD_CMD) throw new TypeError("No build command defined");

async function getLatestCommitId(): Promise<string | null> {
    try {
        const response = await axios.get(`https://api.github.com/repos/${OWNER_NAME}/${REPO_NAME}/branches/${BRANCH_NAME}`, {
            headers: { Accept: "application/json" }
        });
        if (response.status !== 200 || !response.data) return null;
        const data = response.data as GitHubBranch;

        return data.commit.sha ?? null;
    } catch {
        return null;
    }
}

interface GitHubBranch {
    name: string;
    commit: {
        sha: string;
        url: string;
    };
}

function spawnIndexProcess() {
    if (!existsSync("index.js")) {
        console.warn("[Updater] index.js does not exist");
        return;
    }
    exec("node index.js");
}

async function pullFromRepoHook(code: number | null, commitId: string) {
    if (code !== 0) {
        console.error("[Updater] Git crashed with code", code);
        return;
    }
    try {
        await fs.writeFile(COMMIT_SAVE_FILE, commitId);
    } catch (error) {
        console.error("[Updater] Failed to save commit hash file:", error);
        return;
    }

    console.info("[Updater] Updated to", commitId);
    const buildProcess = exec(BUILD_CMD!);

    if (buildProcess.stderr) {
        readReadable(buildProcess.stderr, true);
    }

    buildProcess.on("close", (code) => {
        if (code !== 0) {
            console.warn("[Updater] Build failed -> continuing on previous build");
        }
        spawnIndexProcess();
    });
}

function readReadable(readable: Readable, isError?: boolean) {
    readable.on("readable", () => {
        const buffer = readable.read() as Buffer | null;
        if (!buffer) return;
        isError ? console.error(buffer.toString("ascii")) : console.info(buffer.toString("ascii"));
    });
}

async function main() {
    const saved = await readSavedCommitId();
    const latest = await getLatestCommitId();
    if (!latest) {
        console.warn("[Updater] Failed to check latest commit id");
        spawnIndexProcess();
        return;
    }
    if (saved === latest) {
        console.info("[Updater] Up to date");
        spawnIndexProcess();
        return;
    }

    try {
        execSync(`git remote add origin https://github.com/${OWNER_NAME}/${REPO_NAME}.git`);
    } catch {
        console.warn("[Updater] Remote could not be set/might already be set");
    }
    try {
        execSync(`git fetch origin`);
    } catch {
        console.error("[Updater] Failed to fetch origin -> continuing on previous build");
        spawnIndexProcess();
        return;
    }
    const process = exec(`git checkout origin/${BRANCH_NAME} -- .`);
    process.on("close", (code) => pullFromRepoHook(code, latest));
    if (process.stderr) {
        readReadable(process.stderr, true);
    }
}

main();
