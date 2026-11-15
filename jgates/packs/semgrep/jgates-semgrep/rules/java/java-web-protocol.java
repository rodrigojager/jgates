import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.websocket.ContainerProvider;
import javax.websocket.WebSocketContainer;
import javax.ws.rs.HeaderParam;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.Response;
import graphql.GraphQL;
import graphql.analysis.MaxQueryDepthInstrumentation;
import okhttp3.Request;
import org.springframework.graphql.execution.GraphQlSource;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.servlet.view.RedirectView;
import org.springframework.web.socket.client.WebSocketClient;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.messaging.WebSocketStompClient;

class WebProtocolFixture {
    static String validateRedirect(String value) { return value; }

    // ---- security-headers-disabled ----
    void headersSpring(Object http) throws Exception {
        // ruleid: jgates.java.security-headers-disabled
        http.headers().frameOptions().disable();
        // ruleid: jgates.java.security-headers-disabled
        http.headers().contentTypeOptions().disable();
        // ruleid: jgates.java.security-headers-disabled
        http.headers().httpStrictTransportSecurity().disable();
        // ruleid: jgates.java.security-headers-disabled
        http.headers(h -> h.frameOptions(f -> f.disable()));
        // ruleid: jgates.java.security-headers-disabled
        http.headers(h -> h.httpStrictTransportSecurity(hsts -> hsts.maxAgeInSeconds(86400)));
        // ruleid: jgates.java.security-headers-disabled
        http.headers(h -> h.contentTypeOptions(Customizer::disable));
        // ruleid: jgates.java.security-headers-disabled
        http.headers().disable();
        // ok: jgates.java.security-headers-disabled
        http.headers().frameOptions().sameOrigin();
        // ok: jgates.java.security-headers-disabled
        http.headers(h -> h.httpStrictTransportSecurity(hsts -> hsts.maxAgeInSeconds(31536000).includeSubDomains(true)));
        // ok: jgates.java.security-headers-disabled
        http.headers(h -> h.frameOptions(f -> f.deny()));
        // ok: jgates.java.security-headers-disabled
        http.csrf(c -> c.disable());
    }

    // ---- csp-unsafe-directive ----
    void cspHeaders(HttpServletResponse res, Object http, Object headers) {
        // ruleid: jgates.java.csp-unsafe-directive
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'");
        // ruleid: jgates.java.csp-unsafe-directive
        res.addHeader("Content-Security-Policy", "script-src 'self' 'unsafe-eval'");
        // ruleid: jgates.java.csp-unsafe-directive
        http.headers().contentSecurityPolicy("script-src * ; object-src 'none'");
        // ruleid: jgates.java.csp-unsafe-directive
        headers.set("Content-Security-Policy", "default-src https: ; img-src 'self'");
        // ok: jgates.java.csp-unsafe-directive
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-abc123'");
        // ok: jgates.java.csp-unsafe-directive
        res.setHeader("Content-Security-Policy", "script-src 'self'; style-src 'self' 'unsafe-inline'");
        // ok: jgates.java.csp-unsafe-directive
        http.headers().contentSecurityPolicy("default-src 'self'; frame-ancestors 'none'");
        // ok: jgates.java.csp-unsafe-directive
        res.setHeader("X-Content-Type-Options", "nosniff");
    }

    // ---- websocket-without-tls ----
    void wsClients(WebSocketContainer container, HttpClient http, WebSocketClient springClient, WebSocketStompClient stomp, Object endpoint, Object listener, Object handler) throws Exception {
        // ruleid: jgates.java.websocket-without-tls
        container.connectToServer(endpoint, URI.create("ws://feed.example.com/stream"));
        // ruleid: jgates.java.websocket-without-tls
        http.newWebSocketBuilder().buildAsync(URI.create("ws://feed.example.com/live"), listener);
        // ruleid: jgates.java.websocket-without-tls
        springClient.execute(handler, "ws://10.1.2.3:8080/ws");
        // ruleid: jgates.java.websocket-without-tls
        stomp.connect("ws://broker.example.com/stomp", handler);
        // ruleid: jgates.java.websocket-without-tls
        Request req = new Request.Builder().url("ws://chat.example.com/socket").build();
        // ok: jgates.java.websocket-without-tls
        container.connectToServer(endpoint, URI.create("wss://feed.example.com/stream"));
        // ok: jgates.java.websocket-without-tls
        http.newWebSocketBuilder().buildAsync(URI.create("ws://localhost:8080/dev"), listener);
        // ok: jgates.java.websocket-without-tls
        stomp.connect("wss://broker.example.com/stomp", handler);
        // ok: jgates.java.websocket-without-tls
        Request safe = new Request.Builder().url("wss://chat.example.com/socket").build();
    }

    // ---- websocket-origin-not-checked ----
    void wsRegistry(WebSocketHandlerRegistry registry, Object handler, Object stompRegistry) {
        // ruleid: jgates.java.websocket-origin-not-checked
        registry.addHandler(handler, "/ws").setAllowedOrigins("*");
        // ruleid: jgates.java.websocket-origin-not-checked
        registry.addHandler(handler, "/ws").addInterceptors(handler).setAllowedOriginPatterns("*");
        // ruleid: jgates.java.websocket-origin-not-checked
        stompRegistry.addEndpoint("/stomp").setAllowedOriginPatterns("*");
        // ok: jgates.java.websocket-origin-not-checked
        registry.addHandler(handler, "/ws").setAllowedOrigins("https://app.example.com");
        // ok: jgates.java.websocket-origin-not-checked
        stompRegistry.addEndpoint("/stomp").setAllowedOriginPatterns("https://*.example.com");
    }

    class OpenConfigurator {
        // ruleid: jgates.java.websocket-origin-not-checked
        @Override
        public boolean checkOrigin(String origin) {
            return true;
        }
    }

    class StrictConfigurator {
        // ok: jgates.java.websocket-origin-not-checked
        @Override
        public boolean checkOrigin(String origin) {
            return "https://app.example.com".equals(origin);
        }
    }

    // ---- graphql-without-depth-limit ----
    GraphQL graphqlServers(Object schema) {
        // ruleid: jgates.java.graphql-without-depth-limit
        GraphQL a = GraphQL.newGraphQL(schema).build();
        // ruleid: jgates.java.graphql-without-depth-limit
        GraphQlSource b = GraphQlSource.schemaResourceBuilder().schemaResources(schema).build();
        // ok: jgates.java.graphql-without-depth-limit
        GraphQL c = GraphQL.newGraphQL(schema).instrumentation(new MaxQueryDepthInstrumentation(10)).build();
        // ok: jgates.java.graphql-without-depth-limit
        GraphQlSource d = GraphQlSource.schemaResourceBuilder().schemaResources(schema).instrumentation(java.util.List.of(new MaxQueryDepthInstrumentation(8))).build();
        return a;
    }

    // ---- open-redirect ----
    void redirectServlet(HttpServletRequest req, HttpServletResponse res) throws Exception {
        String next = req.getParameter("next");
        // ruleid: jgates.java.open-redirect
        res.sendRedirect(next);
        // ruleid: jgates.java.open-redirect
        res.setHeader("Location", req.getParameter("url"));
        // ok: jgates.java.open-redirect
        res.sendRedirect("/home");
        // ok: jgates.java.open-redirect
        res.sendRedirect(validateRedirect(next));
    }

    String redirectSpring(@RequestParam("returnTo") String returnTo) {
        // ruleid: jgates.java.open-redirect
        return "redirect:" + returnTo;
    }

    Object redirectView(@RequestParam("target") String target) {
        // ruleid: jgates.java.open-redirect
        return new RedirectView(target);
    }

    Response redirectJaxrs(@QueryParam("to") String to) {
        // ruleid: jgates.java.open-redirect
        return Response.seeOther(URI.create(to)).build();
    }

    String redirectAllowList(@RequestParam("returnTo") String returnTo, java.util.Set<String> allowed) {
        if (allowed.contains(returnTo)) {
            // ok: jgates.java.open-redirect
            return "redirect:" + returnTo;
        }
        // ok: jgates.java.open-redirect
        return "redirect:/home";
    }

    // ---- client-ip-from-forwarded-header ----
    String clientIp(HttpServletRequest req, org.springframework.http.HttpHeaders headers) {
        // ruleid: jgates.java.client-ip-from-forwarded-header
        String a = req.getHeader("X-Forwarded-For");
        // ruleid: jgates.java.client-ip-from-forwarded-header
        String b = req.getHeader("x-real-ip");
        // ruleid: jgates.java.client-ip-from-forwarded-header
        String c = headers.getFirst("X-Forwarded-For");
        // ok: jgates.java.client-ip-from-forwarded-header
        String d = req.getRemoteAddr();
        // ok: jgates.java.client-ip-from-forwarded-header
        String e = req.getHeader("User-Agent");
        return d;
    }

    // ruleid: jgates.java.client-ip-from-forwarded-header
    String ipFromAnnotation(@RequestHeader("X-Forwarded-For") String forwarded) {
        return forwarded;
    }

    // ok: jgates.java.client-ip-from-forwarded-header
    String ipFromRemote(HttpServletRequest req, @RequestHeader("Accept-Language") String lang) {
        return req.getRemoteAddr();
    }

    // ---- host-header-in-url ----
    String hostLinks(HttpServletRequest req, String token, String baseUrl) throws Exception {
        String host = req.getHeader("Host");
        // ruleid: jgates.java.host-header-in-url
        String reset = "https://" + host + "/reset?t=" + token;
        // ruleid: jgates.java.host-header-in-url
        String home = String.format("https://%s/home", req.getServerName());
        // ruleid: jgates.java.host-header-in-url
        URL url = new URL("https", host, "/verify");
        // ok: jgates.java.host-header-in-url
        String safeReset = baseUrl + "/reset?t=" + token;
        // ok: jgates.java.host-header-in-url
        String safeHome = String.format("%s/home", baseUrl);
        return reset;
    }
}
