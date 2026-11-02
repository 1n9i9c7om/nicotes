import { z } from 'zod';

/** Personal access tokens start with this, so they are easy to recognise (and to find in leaks). */
export const API_TOKEN_PREFIX = 'nct_';

/**
 * "read" tokens may only use GET; "write" tokens may change notes too; "calendar" tokens
 * only open the calendar feed (their token is part of its address).
 */
export const API_TOKEN_SCOPES = ['read', 'write', 'calendar'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKEN_SCOPE_LABELS: Record<ApiTokenScope, string> = {
  read: 'Read only',
  write: 'Read and write',
  calendar: 'Calendar feed',
};

/** The calendar feed of a calendar token, relative to the server: `/api/calendar/<token>.ics`. */
export const calendarFeedPath = (token: string) => `/api/calendar/${token}.ics`;

/** A token as listed in Settings: never the token itself, only its last characters. */
export interface ApiToken {
  id: string;
  name: string;
  scope: ApiTokenScope;
  /** The token's last four characters. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(API_TOKEN_SCOPES),
  /** null: never expires. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type ApiTokenCreate = z.input<typeof apiTokenCreateSchema>;

/** POST /api/tokens: the token itself is only ever returned here. */
export interface CreatedApiToken {
  token: string;
  info: ApiToken;
}
