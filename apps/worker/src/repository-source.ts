import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface RepositorySnapshotTarget {
  githubInstallationId: number;
  githubRepositoryId: number;
  repositoryFullName: string;
  ref: string;
}

export interface RepositorySnapshot {
  path: string;
  commitSha: string;
  cleanup(): Promise<void>;
}

export interface RepositorySource {
  materialize(target: RepositorySnapshotTarget): Promise<RepositorySnapshot>;
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha1");

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1).split(sep).join("/");
      hash.update(relative);
      hash.update("\0");

      if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(path);
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(await readFile(path));
      } else if (entry.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await readlink(path));
      } else {
        throw new Error(`Unsupported local repository entry: ${relative}`);
      }

      hash.update("\0");
    }
  }

  await visit(root);
  return hash.digest("hex");
}

export class LocalDirectoryRepositorySource implements RepositorySource {
  constructor(private readonly sourcePath: string) {}

  async materialize(_target: RepositorySnapshotTarget): Promise<RepositorySnapshot> {
    const source = await realpath(this.sourcePath);

    if (!(await lstat(source)).isDirectory()) {
      throw new Error("Local repository source must be a directory");
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "devsentinel-run-"));
    const workspace = join(temporaryRoot, "workspace");

    try {
      await cp(source, workspace, {
        recursive: true,
        dereference: false,
        filter(path) {
          if (path === source) {
            return true;
          }

          const relative = resolve(path).slice(source.length + 1);
          return !relative
            .split(sep)
            .some((segment) =>
              [".git", ".devsentinel", "node_modules"].includes(segment),
            );
        },
      });
      const workspaceRealPath = await realpath(workspace);

      if (!workspaceRealPath.startsWith(`${temporaryRoot}${sep}`)) {
        throw new Error("Local repository copy escaped its temporary root");
      }

      const commitSha = await hashDirectory(workspaceRealPath);
      return {
        path: workspaceRealPath,
        commitSha,
        async cleanup(): Promise<void> {
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }
}

export function resolveWorkspacePath(path: string, workspaceRoot: string): string {
  return path.startsWith(sep) ? path : resolve(workspaceRoot, path);
}
