import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.util.Set;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import graphql.GraphQL;
import graphql.analysis.MaxQueryDepthInstrumentation;
import graphql.schema.GraphQLSchema;
import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.visibility.NoIntrospectionGraphqlFieldVisibility;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

public class WebProtocol {
    private static final Set<String> ALLOWED_TARGETS = Set.of("/home", "/account");

    void configureHeaders(Object http) throws Exception {
        http.headers().frameOptions().sameOrigin();
    }

    void applyPolicy(HttpServletResponse res) {
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-r4nd0m'");
    }

    void openFeed(HttpClient client, Object listener) {
        client.newWebSocketBuilder().buildAsync(URI.create("wss://feed.example.com/live"), listener);
    }

    void registerHandlers(WebSocketHandlerRegistry registry, Object handler) {
        registry.addHandler(handler, "/ws").setAllowedOrigins("https://app.example.com");
    }

    GraphQL createGraphql(Object queryType) {
        GraphQLSchema schema = GraphQLSchema.newSchema().query(queryType)
            .codeRegistry(GraphQLCodeRegistry.newCodeRegistry()
                .fieldVisibility(NoIntrospectionGraphqlFieldVisibility.NO_INTROSPECTION_FIELD_VISIBILITY).build()).build();
        return GraphQL.newGraphQL(schema).instrumentation(new MaxQueryDepthInstrumentation(10)).build();
    }

    void redirectAfterLogin(HttpServletRequest req, HttpServletResponse res) throws Exception {
        String next = req.getParameter("next");
        if (ALLOWED_TARGETS.contains(next)) {
            res.sendRedirect(next);
        } else {
            res.sendRedirect("/home");
        }
    }

    String clientAddress(HttpServletRequest req) {
        return req.getRemoteAddr();
    }

    String resetLink(String baseUrl, String token) {
        return baseUrl + "/reset?t=" + token;
    }
}
