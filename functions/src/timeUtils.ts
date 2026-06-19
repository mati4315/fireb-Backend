import * as admin from 'firebase-admin';

export const isExpired = (value: unknown): boolean => {
  if (!value) return false;
  if (value instanceof admin.firestore.Timestamp) {
    return value.toMillis() <= Date.now();
  }

  if (value instanceof Date) {
    return value.getTime() <= Date.now();
  }

  return false;
};
