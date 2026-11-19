import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.beanutils.BeanUtils;

public class Configuration {
    void startup(Object http, Object files, Object context, Object serverConfig) {
        System.setProperty("debug", "true");
        http.authorizeRequests().requestMatchers("/actuator/**").permitAll();
        files.setDirectoriesListed(true);
        serverConfig.setSendServerVersion(true);
    }

    void updateUser(HttpServletRequest req, HttpServletResponse resp, Object user) throws Exception {
        resp.setHeader("Content-Type", "text/html");
        BeanUtils.populate(user, req.getParameterMap());
    }

    ObjectMapper mapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.setVisibility(PropertyAccessor.FIELD, Visibility.ANY);
        return mapper;
    }
}
