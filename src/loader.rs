const TEMPLATE: &str = include_str!("../lua/loader.lua.tpl");

pub fn build_loader_lua(server_port: u16, secret: &Option<String>, exchange_dir: &str) -> String {
    let secret_val = secret.as_deref().unwrap_or("");
    TEMPLATE
        .replace("{{PORT}}", &server_port.to_string())
        .replace("{{SECRET}}", secret_val)
        .replace("{{EXCHANGE_DIR}}", exchange_dir)
}
