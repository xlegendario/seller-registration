// airtableClient.js
import Airtable from 'airtable';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_SELLERS_TABLE = 'Sellers',
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing Airtable env vars.');
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const sellersTable = base(AIRTABLE_SELLERS_TABLE);

export { sellersTable };
