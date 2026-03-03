import { beforeAll, afterAll, vi } from 'vitest';

// Mock environment variables for testing
process.env.GITHUB_TOKEN = 'test-token';
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.GEMINI_API_KEY = '';
process.env.MISTRAL_API_KEY = '';

// Mock console methods to reduce noise in tests
const originalConsole = { ...console };

beforeAll(() => {
  // Suppress logs in tests unless DEBUG is set
  if (!process.env.DEBUG) {
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    console.info = vi.fn();
    console.debug = vi.fn();
  }
});

afterAll(() => {
  // Restore console
  if (!process.env.DEBUG) {
    Object.assign(console, originalConsole);
  }
});

// Global test utilities
declare global {
  namespace NodeJS {
    interface Global {
      testUtils: {
        sleep: (ms: number) => Promise<void>;
        mockOctokit: () => any;
        mockWebhook: (event: string, payload: any) => any;
      };
    }
  }
}

(global as any).testUtils = {
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  
  mockOctokit: () => ({
    rest: {
      pulls: {
        get: vi.fn(),
        listReviewComments: vi.fn(),
        listReviews: vi.fn(),
      },
      issues: {
        createComment: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
    },
    paginate: vi.fn(),
  }),

  mockWebhook: (event: string, payload: any) => ({
    id: 'test-delivery-id',
    name: event,
    payload,
  }),
};
