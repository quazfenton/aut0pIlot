import * as fs from 'fs';
import * as path from 'path';

export interface PendingPatch {
  id: string;
  repo: string;
  prNumber: number;
  commentId: string;
  file: string;
  patch: string;
  generatedAt: string;
  commitSha: string;
  status: 'pending' | 'committed' | 'failed';
  error?: string;
}

export class PendingPatchManager {
  private baseDir: string;
  private pendingFile: string;

  constructor(baseDir: string = './.pr-autopilot') {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    this.pendingFile = path.join(baseDir, 'pending-patches.json');
  }

  load(): PendingPatch[] {
    if (!fs.existsSync(this.pendingFile)) {
      return [];
    }
    try {
      const content = fs.readFileSync(this.pendingFile, 'utf-8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
    } catch {
      return [];
    }
  }

  save(patches: PendingPatch[]): void {
    fs.writeFileSync(this.pendingFile, JSON.stringify(patches, null, 2));
  }

  add(patch: Omit<PendingPatch, 'id' | 'generatedAt' | 'status'>): PendingPatch {
    const patches = this.load();
    const newPatch: PendingPatch = {
      ...patch,
      id: `${patch.repo.replace(/\//g, '_')}_${patch.prNumber}_${patch.commentId}_${Date.now()}`,
      generatedAt: new Date().toISOString(),
      status: 'pending',
    };
    patches.push(newPatch);
    this.save(patches);
    return newPatch;
  }

  markCommitted(id: string, commitSha?: string): void {
    const patches = this.load();
    const patch = patches.find(p => p.id === id);
    if (patch) {
      patch.status = 'committed';
      if (commitSha) {
        patch.commitSha = commitSha;
      }
      this.save(patches);
    }
  }

  markFailed(id: string, error: string): void {
    const patches = this.load();
    const patch = patches.find(p => p.id === id);
    if (patch) {
      patch.status = 'failed';
      patch.error = error;
      this.save(patches);
    }
  }

  getPending(): PendingPatch[] {
    return this.load().filter(p => p.status === 'pending');
  }

  getCommitted(): PendingPatch[] {
    return this.load().filter(p => p.status === 'committed');
  }

  getFailed(): PendingPatch[] {
    return this.load().filter(p => p.status === 'failed');
  }

  remove(id: string): void {
    const patches = this.load();
    const index = patches.findIndex(p => p.id === id);
    if (index !== -1) {
      patches.splice(index, 1);
      this.save(patches);
    }
  }

  cleanup(daysOld: number = 7): number {
    const patches = this.load();
    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const remaining = patches.filter(p => {
      const generatedAt = new Date(p.generatedAt).getTime();
      return p.status === 'pending' || generatedAt > cutoff;
    });
    const removed = patches.length - remaining.length;
    this.save(remaining);
    return removed;
  }
}
