'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isUniqueConflict,
  withTransactionRetry,
} = require('../../cloudfunctions/_shared/transaction')

test('unique conflicts are recognized without parsing messages', () => {
  assert.equal(isUniqueConflict({ errCode: -502003 }), true)
  assert.equal(isUniqueConflict({ message: 'duplicate index name' }), false)
})

test('transaction conflicts retry a finite number of times', async () => {
  let attempts = 0
  let rollbacks = 0
  const db = {
    startTransaction: async () => ({
      commit: async () => {},
      rollback: async () => { rollbacks += 1 },
    }),
  }
  const result = await withTransactionRetry(db, async () => {
    attempts += 1
    if (attempts < 3) throw { code: 'TRANSACTION_CONFLICT' }
    return 'done'
  })
  assert.equal(result, 'done')
  assert.equal(attempts, 3)
  assert.equal(rollbacks, 2)
})
