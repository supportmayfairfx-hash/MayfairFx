type User = { id: string; email: string; first_name?: string | null; created_at: string };
type Profile = {
  user_id: string;
  initial_capital: number;
  initial_asset?: string | null;
  initial_units?: number | null;
  created_at: string;
  updated_at: string;
};

const USER_KEY = "tf_user_v1";
const PROFILE_LATEST_KEY = "tf_profile_latest_v1";
const profileUserKey = (userId: string) => `tf_profile_v1:${userId}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function cacheUser(user: User | null | undefined) {
  if (!user) return;
  writeJson(USER_KEY, user);
}

export function getCachedUser(): User | null {
  return readJson<User>(USER_KEY);
}

export function clearCachedSession() {
  try {
    const u = getCachedUser();
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PROFILE_LATEST_KEY);
    if (u?.id) localStorage.removeItem(profileUserKey(u.id));
  } catch {}
}

export function cacheProfile(profile: Profile | null | undefined) {
  if (!profile) return;
  writeJson(PROFILE_LATEST_KEY, profile);
  if (profile.user_id) writeJson(profileUserKey(profile.user_id), profile);
}

export function getCachedProfile(userId?: string | null): Profile | null {
  if (userId) {
    const p = readJson<Profile>(profileUserKey(userId));
    if (p) return p;
  }
  return readJson<Profile>(PROFILE_LATEST_KEY);
}
