const express = require('express');
const authRoutes = require('./routes/auth');
const memoryRoutes = require('./routes/memory');

const app = express();
app.use(express.json());

// conexão pool já configurada antes
app.set('db', pool);

app.use('/api', authRoutes);
app.use('/api', memoryRoutes);

app.listen(4000, () => {
  console.log('HDUD API v0.1 rodando em http://localhost:4000');
});
