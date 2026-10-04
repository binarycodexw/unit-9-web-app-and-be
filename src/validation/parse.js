import { idParam } from './schemas.js';

// returns { data } or { errors, values } (first error message per field)
export function parseForm(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (result.success) {
    return { data: result.data, errors: null };
  }

  const errors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] ?? '_form';
    if (!(field in errors)) errors[field] = issue.message;
  }
  return { data: null, errors };
}

// null unless the param is a positive integer
export function parseId(value) {
  const result = idParam.safeParse(value);
  return result.success ? result.data : null;
}

// don't send passwords or codes back into the form
export function safeValues(input, hiddenFields = ['password', 'confirmPassword', 'code']) {
  const values = { ...(input ?? {}) };
  for (const field of hiddenFields) delete values[field];
  delete values._csrf;
  return values;
}
