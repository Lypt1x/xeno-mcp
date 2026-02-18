const TEMPLATE: &str = include_str!("../lua/loader.lua.tpl");

pub fn build_loader_lua(server_port: u16, secret: &Option<String>, exchange_dir: &str, executor_exchange_dir: &Option<String>) -> String {
    let secret_val = secret.as_deref().unwrap_or("");
    let lua_dir = executor_exchange_dir.as_deref().unwrap_or(exchange_dir);
    let normalized_dir = lua_dir.replace('\\', "/");
    TEMPLATE
        .replace("{{PORT}}", &server_port.to_string())
        .replace("{{SECRET}}", secret_val)
        .replace("{{EXCHANGE_DIR}}", &normalized_dir)
}
