import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMutationSerializer, hardenPrivateFile, writePrivateJson } from './private-json-store.js';

export class OperationsEventStore {
  constructor(workDir) {
    this.file = path.join(workDir, 'operations-events.json');
    this.events = [];
    this.serializeMutation = createMutationSerializer();
  }

  async runMutation(operation) {
    return this.serializeMutation(async () => {
      const snapshot = structuredClone(this.events);
      try {
        return await operation();
      } catch (error) {
        this.events = snapshot;
        throw error;
      }
    });
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const events = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.events = Array.isArray(events) ? events : [];
      await hardenPrivateFile(this.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() { return [...this.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  async record({ subjectType, subjectRef, eventType, severity = 'warning', safeMessage, recommendedAction, taskRefs = [], attemptedRecovery = null }) {
    return this.runMutation(async () => {
      const event = {
        schemaVersion: '3.0', eventId: crypto.randomUUID(), subjectType, subjectRef, eventType, severity,
        safeMessage: redact(safeMessage), recommendedAction, attemptedRecovery, taskRefs: [...new Set(taskRefs)],
        createdAt: new Date().toISOString(), resolvedAt: null
      };
      this.events.push(event);
      await this.persist();
      return event;
    });
  }

  async persist() {
    await writePrivateJson(this.file, this.events);
  }
}

export function redact(value) {
  return String(value || '')
    .replace(/(cookie|token|password|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .slice(0, 500);
}
