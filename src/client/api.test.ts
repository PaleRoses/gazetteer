import { expect, test } from 'bun:test';
import { invitationSchema } from './api';

test('invitation receipts cannot fabricate email delivery', () => {
  const link = { email: 'teammate@example.com', url: 'http://localhost:4310/?invite=test' };
  expect(invitationSchema.safeParse({ ...link, delivery: 'link-only' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted', messageId: 'provider-receipt' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'unconfirmed', warning: 'Provider timed out.' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted' }).success).toBe(false);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted', messageId: '' }).success).toBe(false);
  expect(invitationSchema.safeParse({ ...link, delivery: 'sent' }).success).toBe(false);
});
