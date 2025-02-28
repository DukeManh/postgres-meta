import { ident, literal } from 'pg-format'
import { DEFAULT_SYSTEM_SCHEMAS } from './constants'
import { coalesceRowsToArray } from './helpers'
import {
  columnsSql,
  grantsSql,
  policiesSql,
  primaryKeysSql,
  relationshipsSql,
  tablesSql,
} from './sql'
import { PostgresMetaResult, PostgresTable } from './types'

export default class PostgresMetaTables {
  query: (sql: string) => Promise<PostgresMetaResult<any>>

  constructor(query: (sql: string) => Promise<PostgresMetaResult<any>>) {
    this.query = query
  }

  async list({
    includeSystemSchemas = false,
    limit,
    offset,
  }: {
    includeSystemSchemas?: boolean
    limit?: number
    offset?: number
  } = {}): Promise<PostgresMetaResult<PostgresTable[]>> {
    let sql = enrichedTablesSql
    if (!includeSystemSchemas) {
      sql = `${sql} WHERE NOT (schema IN (${DEFAULT_SYSTEM_SCHEMAS.map(literal).join(',')}))`
    }
    if (limit) {
      sql = `${sql} LIMIT ${limit}`
    }
    if (offset) {
      sql = `${sql} OFFSET ${offset}`
    }
    return await this.query(sql)
  }

  async retrieve({ id }: { id: number }): Promise<PostgresMetaResult<PostgresTable>>
  async retrieve({
    name,
    schema,
  }: {
    name: string
    schema: string
  }): Promise<PostgresMetaResult<PostgresTable>>
  async retrieve({
    id,
    name,
    schema = 'public',
  }: {
    id?: number
    name?: string
    schema?: string
  }): Promise<PostgresMetaResult<PostgresTable>> {
    if (id) {
      const sql = `${enrichedTablesSql} WHERE tables.id = ${literal(id)};`
      const { data, error } = await this.query(sql)
      if (error) {
        return { data, error }
      } else if (data.length === 0) {
        return { data: null, error: { message: `Cannot find a table with ID ${id}` } }
      } else {
        return { data: data[0], error }
      }
    } else if (name) {
      const sql = `${enrichedTablesSql} WHERE tables.name = ${literal(
        name
      )} AND tables.schema = ${literal(schema)};`
      const { data, error } = await this.query(sql)
      if (error) {
        return { data, error }
      } else if (data.length === 0) {
        return {
          data: null,
          error: { message: `Cannot find a table named ${name} in schema ${schema}` },
        }
      } else {
        return { data: data[0], error }
      }
    } else {
      return { data: null, error: { message: 'Invalid parameters on table retrieve' } }
    }
  }

  async create({
    name,
    schema = 'public',
    comment,
  }: {
    name: string
    schema?: string
    comment?: string
  }): Promise<PostgresMetaResult<PostgresTable>> {
    const tableSql = `CREATE TABLE ${ident(schema)}.${ident(name)} ();`
    const commentSql =
      comment === undefined
        ? ''
        : `COMMENT ON TABLE ${ident(schema)}.${ident(name)} IS ${literal(comment)};`
    const sql = `BEGIN; ${tableSql} ${commentSql} COMMIT;`
    const { error } = await this.query(sql)
    if (error) {
      return { data: null, error }
    }
    return await this.retrieve({ name, schema })
  }

  async update(
    id: number,
    {
      name,
      schema,
      rls_enabled,
      rls_forced,
      replica_identity,
      replica_identity_index,
      primary_keys,
      comment,
    }: {
      name?: string
      schema?: string
      rls_enabled?: boolean
      rls_forced?: boolean
      replica_identity?: 'DEFAULT' | 'INDEX' | 'FULL' | 'NOTHING'
      replica_identity_index?: string
      primary_keys?: { name: string }[]
      comment?: string
    }
  ): Promise<PostgresMetaResult<PostgresTable>> {
    const { data: old, error } = await this.retrieve({ id })
    if (error) {
      return { data: null, error }
    }

    const alter = `ALTER TABLE ${ident(old!.schema)}.${ident(old!.name)}`
    const schemaSql = schema === undefined ? '' : `${alter} SET SCHEMA ${ident(schema)};`
    let nameSql = ''
    if (name !== undefined && name !== old!.name) {
      const currentSchema = schema === undefined ? old!.schema : schema
      nameSql = `ALTER TABLE ${ident(currentSchema)}.${ident(old!.name)} RENAME TO ${ident(name)};`
    }
    let enableRls = ''
    if (rls_enabled !== undefined) {
      const enable = `${alter} ENABLE ROW LEVEL SECURITY;`
      const disable = `${alter} DISABLE ROW LEVEL SECURITY;`
      enableRls = rls_enabled ? enable : disable
    }
    let forceRls = ''
    if (rls_forced !== undefined) {
      const enable = `${alter} FORCE ROW LEVEL SECURITY;`
      const disable = `${alter} NO FORCE ROW LEVEL SECURITY;`
      forceRls = rls_forced ? enable : disable
    }
    let replicaSql = ''
    if (replica_identity === undefined) {
      // skip
    } else if (replica_identity === 'INDEX') {
      replicaSql = `${alter} REPLICA IDENTITY USING INDEX ${replica_identity_index};`
    } else {
      replicaSql = `${alter} REPLICA IDENTITY ${replica_identity};`
    }
    let primaryKeysSql = ''
    if (primary_keys === undefined) {
      // skip
    } else {
      if (old!.primary_keys.length !== 0) {
        primaryKeysSql += `
DO $$
DECLARE
  r record;
BEGIN
  SELECT conname
    INTO r
    FROM pg_constraint
    WHERE contype = 'p' AND conrelid = ${literal(id)};
  EXECUTE ${literal(`${alter} DROP CONSTRAINT `)} || quote_ident(r.conname);
END
$$;
`
      }

      if (primary_keys.length === 0) {
        // skip
      } else {
        primaryKeysSql += `${alter} ADD PRIMARY KEY (${primary_keys
          .map((x) => ident(x.name))
          .join(',')});`
      }
    }
    const commentSql =
      comment === undefined
        ? ''
        : `COMMENT ON TABLE ${ident(old!.schema)}.${ident(old!.name)} IS ${literal(comment)};`
    // nameSql must be last, right below schemaSql
    const sql = `
BEGIN;
  ${enableRls}
  ${forceRls}
  ${replicaSql}
  ${primaryKeysSql}
  ${commentSql}
  ${schemaSql}
  ${nameSql}
COMMIT;`
    {
      const { error } = await this.query(sql)
      if (error) {
        return { data: null, error }
      }
    }
    return await this.retrieve({ id })
  }

  async remove(id: number, { cascade = false } = {}): Promise<PostgresMetaResult<PostgresTable>> {
    const { data: table, error } = await this.retrieve({ id })
    if (error) {
      return { data: null, error }
    }
    const sql = `DROP TABLE ${ident(table!.schema)}.${ident(table!.name)} ${
      cascade ? 'CASCADE' : 'RESTRICT'
    };`
    {
      const { error } = await this.query(sql)
      if (error) {
        return { data: null, error }
      }
    }
    return { data: table!, error: null }
  }
}

const enrichedTablesSql = `
WITH tables AS (${tablesSql}),
  columns AS (${columnsSql}),
  grants AS (${grantsSql}),
  policies AS (${policiesSql}),
  primary_keys AS (${primaryKeysSql}),
  relationships AS (${relationshipsSql})
SELECT
  *,
  ${coalesceRowsToArray('columns', 'columns.table_id = tables.id')},
  ${coalesceRowsToArray('grants', 'grants.table_id = tables.id')},
  ${coalesceRowsToArray('policies', 'policies.table_id = tables.id')},
  ${coalesceRowsToArray('primary_keys', 'primary_keys.table_id = tables.id')},
  ${coalesceRowsToArray(
    'relationships',
    `(relationships.source_schema = tables.schema AND relationships.source_table_name = tables.name)
       OR (relationships.target_table_schema = tables.schema AND relationships.target_table_name = tables.name)`
  )}
FROM tables`
