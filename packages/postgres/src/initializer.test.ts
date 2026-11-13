import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from './initializer.js';

describe('SQL statement splitter', () => {
  it('splits plain statements', () => {
    const statements = splitSqlStatements('SELECT 1;\nSELECT 2;\n');
    expect(statements).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps dollar-quoted blocks intact', () => {
    const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'secret';
  END IF;
END
$$;
SELECT 1;
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE ROLE app');
    expect(statements[0].endsWith('$$')).toBe(true);
  });

  it('keeps tagged dollar-quoted blocks intact', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1; END $body$ LANGUAGE plpgsql; SELECT 2;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('$body$');
  });

  it('does not split on semicolons inside string literals', () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('a;b'); SELECT 2;`);
    expect(statements).toEqual([`INSERT INTO t VALUES ('a;b')`, 'SELECT 2']);
  });

  it('handles escaped quotes inside strings', () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('it''s;fine'); SELECT 2;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("it''s;fine");
  });

  it('ignores line and block comments', () => {
    const statements = splitSqlStatements(`
-- a comment with ; inside
/* block ; comment */
SELECT 1;
`);
    expect(statements).toEqual(['SELECT 1']);
  });

  it('keeps a trailing statement without a semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });
});
