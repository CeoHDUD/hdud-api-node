const express = require('express');
const sql = require('mssql');
const authRoutes = require('./routes/auth');
const memoryRoutes = require('./routes/memory');

const app = express();
app.use(express.json());

// aqui entra a criação do pool do SQL Server...
// const pool = await sql.connect(config);
app.set('db', pool);

app.use('/api', authRoutes);
app.use('/api', memoryRoutes);

app.listen(4000, () => {
  console.log('HDUD API v0.1 rodando em http://localhost:4000');
});
