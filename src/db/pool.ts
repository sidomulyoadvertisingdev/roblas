import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const createPool = (config: DatabaseConfig): Pool => {
  const options: PoolOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    dateStrings: false,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    namedPlaceholders: true,
  };
  return mysql.createPool(options);
};
