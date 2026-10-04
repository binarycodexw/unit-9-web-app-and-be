import { z } from 'zod';


// blank form fields arrive as '', treat them as missing
const emptyToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const positiveInt = z.coerce.number().int().positive().max(2_147_483_647);

const price = z.coerce
  .number({ invalid_type_error: 'Enter a valid number.' })
  .positive('Price must be greater than zero.')
  .max(1_000_000_000, 'Price is too large.');

const optionalPrice = z.preprocess(emptyToUndefined, price.optional());

// short list of very common passwords, a real system would use a bigger list or the HIBP api
const COMMON_PASSWORDS = new Set([
  'password1234', 'passwordpassword', '123456789012', 'qwertyuiop12', 'letmein12345',
  'welcome12345', 'iloveyou1234', 'administrator', 'changeme1234', 'password12345',
]);

export const emailField = z
  .string({ required_error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .min(3, 'Enter a valid email address.')
  .max(254, 'Email is too long.')
  .email('Enter a valid email address, for example name@domain.com.');

export const passwordField = z
  .string({ required_error: 'Password is required.' })
  .min(12, 'Use at least 12 characters (a passphrase works well).')
  .max(128, 'Password must be at most 128 characters.')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), 'That password is too common.');

const mfaCode = z
  .string({ required_error: 'Enter the 6-digit code.' })
  .trim()
  .regex(/^\d{6}$/, 'The code must be exactly 6 digits.');


export const registerSchema = z
  .object({
    email: emailField,
    password: passwordField,
    confirmPassword: z.string({ required_error: 'Please repeat the password.' }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match.',
  });

export const loginSchema = z.object({
  email: emailField,
  // no length rules on login, so the password policy isn't leaked
  password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.').max(128),
});

export const mfaCodeSchema = z.object({ code: mfaCode });

export const mfaDisableSchema = z.object({
  password: z.string().min(1, 'Password is required.').max(128),
  code: mfaCode,
});

export const watchlistSchema = z.object({
  name: z
    .string({ required_error: 'Name is required.' })
    .trim()
    .min(1, 'Name is required.')
    .max(60, 'Name must be at most 60 characters.'),
});

export const watchlistItemAddSchema = z.object({
  stockId: positiveInt,
  note: z.string().trim().max(500, 'Note must be at most 500 characters.').default(''),
  targetPrice: optionalPrice,
});

export const watchlistItemUpdateSchema = z.object({
  note: z.string().trim().max(500, 'Note must be at most 500 characters.').default(''),
  targetPrice: optionalPrice,
});

export const stockSchema = z.object({
  symbol: z
    .string({ required_error: 'Symbol is required.' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'Use 1-10 characters: letters, digits, "." or "-".'),
  name: z.string({ required_error: 'Name is required.' }).trim().min(1, 'Name is required.').max(120),
  exchange: z.string().trim().min(1, 'Exchange is required.').max(30),
  sector: z.string().trim().min(1, 'Sector is required.').max(60),
});

export const stockSearchSchema = z.object({
  q: z.string().trim().max(60).default(''),
  sector: z.string().trim().max(60).default(''),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});

// chart periods in days, anything else falls back to 60
export const RANGE_OPTIONS = [30, 60, 100];
export const stockRangeSchema = z.object({
  range: z.enum(['30', '60', '100']).catch('60').default('60'),
});

export const idParam = positiveInt;
