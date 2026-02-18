use actix_web::{HttpRequest, HttpResponse};

pub fn json_error(status: actix_web::http::StatusCode, msg: &str) -> HttpResponse {
    HttpResponse::build(status).json(serde_json::json!({
        "ok": false,
        "error": msg,
        "status": status.as_u16(),
    }))
}

pub async fn not_found_handler(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::NOT_FOUND,
        &format!(
            "No endpoint matches {} {}. Available endpoints: GET /health, GET /clients, \
             POST /execute, POST /attach-logger, POST /internal, \
             GET /logs, DELETE /logs",
            req.method(),
            req.path()
        ),
    )
}

pub async fn logs_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /logs. Allowed: GET, DELETE", req.method()),
    )
}

pub async fn clients_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /clients. Allowed: GET", req.method()),
    )
}

pub async fn execute_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /execute. Allowed: POST", req.method()),
    )
}

pub async fn attach_logger_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /attach-logger. Allowed: POST", req.method()),
    )
}

pub async fn internal_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /internal. Allowed: POST", req.method()),
    )
}

pub async fn health_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /health. Allowed: GET", req.method()),
    )
}

pub async fn loader_script_method_not_allowed(req: HttpRequest) -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::METHOD_NOT_ALLOWED,
        &format!("Method {} is not allowed on /loader-script. Allowed: GET", req.method()),
    )
}
