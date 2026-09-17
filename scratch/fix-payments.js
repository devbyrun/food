const { query } = require('../src/db');

async function fixPayments() {
  const res = await query("UPDATE payments SET payment_method = 'cash' WHERE payment_method = 'credit_card'");
  console.log('Successfully updated credit_card payments to cash! Rows updated:', res.rowCount);
  process.exit(0);
}

fixPayments().catch(err => {
  console.error(err);
  process.exit(1);
});
