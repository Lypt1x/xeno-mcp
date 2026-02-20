const TEMPLATE: &str = include_str!("../lua/spy.lua.tpl");

pub fn build_spy_lua(server_port: u16, secret: &Option<String>) -> String {
    let secret_val = secret.as_deref().unwrap_or("");
    TEMPLATE
        .replace("{{PORT}}", &server_port.to_string())
        .replace("{{SECRET}}", secret_val)
}
