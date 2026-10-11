const ELEVATED_ROLE_IDS = new Set([1, 2, 3]);
const ELEVATED_ROLE_PATTERN = /(admin|administrator|maintainer|instructor|teacher|管理员|教师|讲师)/i;

function roleNames(sessionData) {
  return (sessionData?.roles || [])
    .map((entry) => entry?.role?.name)
    .filter(Boolean)
    .map(String);
}

/**
 * Only explicit elevated roles may enter the code-collector admin console.
 * TYPE_GLOBAL alone is intentionally not sufficient because the normal User
 * role is also global.
 */
function isOfficialAdmin(sessionData) {
  if (!sessionData) return false;
  const user = sessionData.user || sessionData;
  if (!user) return false;
  if (user.is_superadmin === true) return true;

  return (sessionData.roles || []).some((entry) => {
    const role = entry?.role || {};
    return ELEVATED_ROLE_IDS.has(Number(role.id)) || ELEVATED_ROLE_PATTERN.test(String(role.name || ''));
  });
}

module.exports = { isOfficialAdmin, roleNames };
