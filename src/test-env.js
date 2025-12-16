import dotenv from 'dotenv';
dotenv.config();

console.log("SERVER:", process.env.DB_SERVER);
console.log("USER:", process.env.DB_USER);
console.log("PASS:", process.env.DB_PASSWORD);
console.log("DB:", process.env.DB_DATABASE);
console.log("PORT:", process.env.DB_PORT);
