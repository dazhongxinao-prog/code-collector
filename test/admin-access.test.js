const test = require('node:test');
const assert = require('node:assert/strict');
const { isOfficialAdmin, roleNames } = require('../adminAccess');

const session = (role) => ({ user: { is_superadmin: false }, roles: [{ role }] });

test('superadmin is always allowed', () => {
  assert.equal(isOfficialAdmin({ user: { is_superadmin: true }, roles: [] }), true);
});

test('default admin, maintainer and instructor role ids are allowed', () => {
  for (const id of [1, 2, 3]) {
    assert.equal(isOfficialAdmin(session({ id, name: 'User', role_type: 'TYPE_GLOBAL' })), true);
  }
});

test('named teacher roles are allowed even when custom ids are used', () => {
  assert.equal(isOfficialAdmin(session({ id: 99, name: 'Course Teacher', role_type: 'TYPE_ORGANIZATION' })), true);
  assert.equal(isOfficialAdmin(session({ id: 100, name: '讲师', role_type: 'TYPE_ORGANIZATION' })), true);
});

test('ordinary global User role is rejected', () => {
  assert.equal(isOfficialAdmin(session({ id: 4, name: 'User', role_type: 'TYPE_GLOBAL' })), false);
  assert.equal(isOfficialAdmin(session({ id: 404, name: '学生', role_type: 'TYPE_GLOBAL' })), false);
});

test('role names are exposed without leaking role objects', () => {
  assert.deepEqual(roleNames(session({ id: 3, name: 'Instructor' })), ['Instructor']);
});
